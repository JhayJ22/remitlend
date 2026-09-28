/**
 * loanCostDisclosure.ts
 *
 * Authoritative, exact-math disclosure of the total cost of a loan (issue #320).
 *
 * Design goals:
 * - **Exact arithmetic.** Every monetary value is carried as `bigint` minor
 *   units of the loan asset and every rate as an integer number of basis
 *   points. Nothing that a borrower is shown is derived from a binary float
 *   multiplication, so the disclosed total always equals the sum of the
 *   disclosed components.
 * - **Explicit validation.** Invalid, unbounded or ambiguous input is rejected
 *   with a typed error code instead of being coerced to `NaN` and rendered.
 * - **Bounded resources.** Input length, term length, rate magnitude and the
 *   number of schedule rows are all capped, so a hostile or corrupt value can
 *   never turn a disclosure render into an unbounded loop or allocation.
 * - **Authoritative-source reconciliation.** The backend amortization preview
 *   is the system of record for settlement. `reconcileWithAmortization` and
 *   `applyAuthoritativeTotals` let a caller prefer server totals over the local
 *   estimate and surface any divergence instead of silently showing one of the
 *   two numbers.
 * - **Additive.** This module is standalone. It changes no deployed contract,
 *   no API response shape and no persisted data.
 */

import { getAssetDecimals } from "./amount";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Simple-interest day count used across the product surface. */
export const DISCLOSURE_DAYS_PER_YEAR = 365;

/** Basis-point denominator (100% === 10 000 bps). */
export const BPS_DENOMINATOR = BigInt(10_000);

/**
 * Nominal annual rate applied when no other rate is supplied. Mirrors the
 * value the wizard and the on-chain loan manager are configured with; kept in
 * one place so the disclosure and the submitted transaction cannot drift.
 */
export const DEFAULT_LOAN_ANNUAL_RATE_BPS = BigInt(1_200);

/** Upper bound for a loan term (5 years). Anything longer is rejected. */
export const MAX_DISCLOSURE_TERM_DAYS = 1_825;

/** Upper bound for any single rate, 1 000 % p.a. */
export const MAX_DISCLOSURE_RATE_BPS = BigInt(100_000);

/** Longest accepted decimal amount string. Bounds the parser's work. */
export const MAX_DISCLOSURE_INPUT_LENGTH = 40;

/** Default cap on late fees: 100 % of principal. */
export const DEFAULT_LATE_FEE_CAP_BPS = BPS_DENOMINATOR;

const MINOR_UNIT_PATTERN = /^\d+(\.\d+)?$/;

/** ISO-4217 code used for `Intl.NumberFormat` per supported loan asset. */
const DISPLAY_CURRENCY_BY_ASSET: Readonly<Record<string, string>> = {
  USDC: "USD",
  EURC: "EUR",
  PHP: "PHP",
  XLM: "XLM",
};

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LoanCostInput {
  /** Principal requested by the borrower, as a decimal string. */
  principal: string;
  /** Loan asset code, e.g. "USDC". Determines minor-unit precision. */
  asset: string;
  /** Repayment term in days. */
  termDays: number;
  /** Nominal annual rate in basis points. */
  annualRateBps: number | bigint;
  /** One-off fee charged on disbursement, in bps of principal. */
  originationFeeBps?: number | bigint;
  /** One-off servicing fee charged on disbursement, in bps of principal. */
  serviceFeeBps?: number | bigint;
  /** Daily late-payment charge, in bps of principal per day. */
  lateFeeBps?: number | bigint;
  /** Ceiling on cumulative late fees, in bps of principal. */
  lateFeeCapBps?: number | bigint;
  /**
   * Network fee paid in the fee asset (normally XLM). It is disclosed
   * separately and never folded into the loan total, because it is not repaid
   * with the loan.
   */
  networkFee?: { amount: string; asset: string };
  /** Disbursement date; defaults to "now". Injected in tests. */
  startDate?: Date;
}

export interface LoanCostScheduleRow {
  period: number;
  dueDate: string;
  principal: string;
  interest: string;
  fees: string;
  total: string;
  balance: string;
}

export interface NetworkFeeDisclosure {
  amount: string;
  asset: string;
  currency: string;
}

/** Where the numbers in a disclosure came from. */
export type DisclosureSource = "estimate" | "authoritative";

export interface LoanCostDisclosure {
  asset: string;
  displayCurrency: string;
  decimals: number;

  /** Amount the borrower asks the protocol for. */
  principal: string;
  /** Amount actually disbursed once upfront fees are deducted. */
  amountFinanced: string;

  annualRateBps: number;
  /** APR including every borrower-borne fee, in bps. */
  effectiveAprBps: number;
  termDays: number;

  interest: string;
  originationFee: string;
  serviceFee: string;
  /** Upfront fees deducted from the disbursement. */
  upfrontFees: string;
  /** Interest plus upfront fees. */
  totalCostOfCredit: string;
  /** Principal plus total cost of credit. */
  totalRepayment: string;

  dailyLateFee: string;
  lateFeeCap: string;

  networkFee: NetworkFeeDisclosure | null;

  dueDate: string;
  schedule: LoanCostScheduleRow[];

  /** True when the input carried more decimals than the asset supports. */
  inputRounded: boolean;
  source: DisclosureSource;

  /** Plain-language statements rendered verbatim by the disclosure panel. */
  statements: string[];
}

export type LoanCostErrorCode =
  | "invalid_principal"
  | "invalid_network_fee"
  | "invalid_term"
  | "invalid_rate"
  | "invalid_fee"
  | "invalid_date"
  | "fees_exceed_principal";

export interface LoanCostError {
  code: LoanCostErrorCode;
  message: string;
  field?: "principal" | "termDays" | "annualRateBps" | "fees" | "networkFee" | "startDate";
}

export type LoanCostResult =
  { ok: true; disclosure: LoanCostDisclosure } | { ok: false; error: LoanCostError };

/** Minimal shape of the backend amortization response needed for reconciliation. */
export interface AmortizationTotalsLike {
  principal: number;
  totalInterest: number;
  totalDue: number;
  interestRateBps?: number;
}

export type ReconciliationStatus = "matched" | "divergent" | "unavailable";

export interface ReconciliationResult {
  status: ReconciliationStatus;
  /** Locally computed total repayment. */
  localTotal: string;
  /** Server-computed total repayment, when one was supplied. */
  authoritativeTotal: string | null;
  /** Signed difference (authoritative minus local), in minor units. */
  delta: string | null;
  /** Tolerance applied to the comparison, in minor units. */
  tolerance: string;
  explanation: string;
}

// ─── Exact bigint helpers ─────────────────────────────────────────────────────

/** Integer division with half-up rounding. `denominator` must be positive. */
export function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= BigInt(0)) {
    throw new Error("divRoundHalfUp requires a positive denominator");
  }
  const negative = numerator < BigInt(0);
  const magnitude = negative ? -numerator : numerator;
  const quotient = magnitude / denominator;
  const remainder = magnitude % denominator;
  const rounded = remainder * BigInt(2) >= denominator ? quotient + BigInt(1) : quotient;
  return negative ? -rounded : rounded;
}

/** `value * numerator / denominator`, rounded half-up. */
export function mulDiv(value: bigint, numerator: bigint, denominator: bigint): bigint {
  return divRoundHalfUp(value * numerator, denominator);
}

/**
 * Parse a non-negative decimal string into minor units, rounding half-up when
 * the input carries more precision than the asset supports.
 *
 * Returns `null` for anything that is not a plain non-negative decimal number
 * (no exponent, no sign, no thousands separators, no whitespace).
 */
export function parseDecimalToMinorUnits(
  value: string,
  decimals: number,
): { minor: bigint; rounded: boolean } | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_DISCLOSURE_INPUT_LENGTH) return null;
  if (!MINOR_UNIT_PATTERN.test(trimmed)) return null;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 12) return null;

  const [whole = "0", fraction = ""] = trimmed.split(".");
  if (fraction.length > decimals) {
    // Round half-up on the first dropped digit, at the asset's precision.
    const kept = fraction.slice(0, decimals);
    const nextDigit = Number(fraction.charAt(decimals));
    const scale = BigInt(10) ** BigInt(decimals);
    const base = BigInt(whole) * scale + BigInt(kept.padEnd(decimals, "0") || "0");
    const increment = nextDigit >= 5 ? BigInt(1) : BigInt(0);
    return { minor: base + increment, rounded: true };
  }

  const scale = BigInt(10) ** BigInt(decimals);
  return {
    minor: BigInt(whole) * scale + BigInt(fraction.padEnd(decimals, "0") || "0"),
    rounded: false,
  };
}

/** Render minor units as a plain decimal string, exactly. */
export function minorUnitsToDecimal(minor: bigint, decimals: number): string {
  const negative = minor < BigInt(0);
  const magnitude = negative ? -minor : minor;
  const scale = BigInt(10) ** BigInt(decimals);
  const whole = magnitude / scale;
  const fraction = (magnitude % scale).toString().padStart(decimals, "0");
  if (decimals === 0) return `${negative ? "-" : ""}${whole.toString()}`;
  return `${negative ? "-" : ""}${whole.toString()}.${fraction}`;
}

/**
 * Render minor units without insignificant trailing zeros, keeping at least
 * one decimal place. Used for values that are echoed next to a symbol (a
 * network fee of `0.0000100` reads as noise next to "0.00001 XLM").
 */
export function minorUnitsToCompactDecimal(minor: bigint, decimals: number): string {
  const exact = minorUnitsToDecimal(minor, decimals);
  if (!exact.includes(".")) return exact;
  const trimmed = exact.replace(/0+$/, "");
  return trimmed.endsWith(".") ? `${trimmed}0` : trimmed;
}

/** Convert a trusted server float to minor units, half-up. */
export function numberToMinorUnits(value: number, decimals: number): bigint | null {
  if (!Number.isFinite(value)) return null;
  const asString = value.toFixed(decimals);
  const parsed = parseDecimalToMinorUnits(asString, decimals);
  return parsed ? parsed.minor : null;
}

/**
 * Resolve an optional rate to basis points.
 *
 * An omitted value falls back; a value that is *present but unusable*
 * (`NaN`, `Infinity`, a non-integer bigint cast, a string) returns `null` so
 * the caller rejects it instead of silently substituting the default rate.
 */
function resolveBps(value: number | bigint | undefined, fallback: bigint): bigint | null {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "bigint") return value;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (!Number.isSafeInteger(value)) return null;
  return BigInt(value);
}

function isValidBps(value: bigint): boolean {
  return value >= BigInt(0) && value <= MAX_DISCLOSURE_RATE_BPS;
}

// ─── Formatting ───────────────────────────────────────────────────────────────

export function getDisplayCurrency(asset: string): string {
  return DISPLAY_CURRENCY_BY_ASSET[asset?.toUpperCase?.() ?? ""] ?? "USD";
}

/** Format a decimal-string amount for display with full asset precision. */
export function formatDisclosureAmount(
  amount: string,
  asset: string,
  { withCurrency = true, locale = "en-US" }: { withCurrency?: boolean; locale?: string } = {},
): string {
  const code = getDisplayCurrency(asset);
  const numeric = Number(amount);
  if (!Number.isFinite(numeric)) {
    return withCurrency ? `${amount} ${asset}` : amount;
  }
  try {
    return new Intl.NumberFormat(locale, {
      style: withCurrency ? "currency" : "decimal",
      ...(withCurrency
        ? { currency: code, currencyDisplay: "narrowSymbol" as const }
        : { minimumFractionDigits: 2, maximumFractionDigits: 7 }),
    }).format(numeric);
  } catch {
    return withCurrency ? `${numeric.toFixed(2)} ${asset}` : numeric.toFixed(2);
  }
}

/** Format basis points as a percentage string, e.g. `1200` -> `"12.00%"`. */
export function formatBps(bps: number): string {
  if (!Number.isFinite(bps)) return "—";
  return `${(bps / 100).toFixed(2)}%`;
}

/** True when a decimal-string amount is exactly zero at the asset's precision. */
export function isZeroAmount(amount: string, decimals: number): boolean {
  const parsed = parseDecimalToMinorUnits(amount, decimals);
  return parsed !== null && parsed.minor === BigInt(0);
}

/** Add `days` to a date and return an ISO `YYYY-MM-DD` string. */
export function addDaysIso(date: Date, days: number): string {
  const next = new Date(date.getTime());
  next.setDate(next.getDate() + days);
  return next.toISOString().slice(0, 10);
}

// ─── Core computation ─────────────────────────────────────────────────────────

/**
 * Compute the full cost disclosure for a loan.
 *
 * Never throws: invalid input resolves to `{ ok: false, error }` so a caller
 * can render a precise message instead of a broken disclosure.
 */
export function computeLoanCostDisclosure(input: LoanCostInput): LoanCostResult {
  if (!input || typeof input !== "object") {
    return { ok: false, error: { code: "invalid_principal", message: "Missing loan terms." } };
  }

  const asset = (input.asset ?? "").toUpperCase();
  if (!asset) {
    return {
      ok: false,
      error: {
        code: "invalid_principal",
        message: "A loan asset is required.",
        field: "principal",
      },
    };
  }
  const decimals = getAssetDecimals(asset);

  // ── Principal ──────────────────────────────────────────────────────────────
  const principalParsed = parseDecimalToMinorUnits(input.principal ?? "", decimals);
  if (!principalParsed) {
    return {
      ok: false,
      error: {
        code: "invalid_principal",
        message: "Enter the loan amount as a positive number with up to 2 decimal places.",
        field: "principal",
      },
    };
  }
  if (principalParsed.minor <= BigInt(0)) {
    return {
      ok: false,
      error: {
        code: "invalid_principal",
        message: "The loan amount must be greater than zero.",
        field: "principal",
      },
    };
  }

  // ── Term ───────────────────────────────────────────────────────────────────
  const { termDays } = input;
  if (
    typeof termDays !== "number" ||
    !Number.isInteger(termDays) ||
    termDays < 1 ||
    termDays > MAX_DISCLOSURE_TERM_DAYS
  ) {
    return {
      ok: false,
      error: {
        code: "invalid_term",
        message: `The repayment term must be a whole number of days between 1 and ${MAX_DISCLOSURE_TERM_DAYS}.`,
        field: "termDays",
      },
    };
  }

  // ── Rates ──────────────────────────────────────────────────────────────────
  const annualRateBps = resolveBps(input.annualRateBps, DEFAULT_LOAN_ANNUAL_RATE_BPS);
  if (annualRateBps === null || !isValidBps(annualRateBps)) {
    return {
      ok: false,
      error: {
        code: "invalid_rate",
        message: "The interest rate is outside the supported range.",
        field: "annualRateBps",
      },
    };
  }

  const originationFeeBps = resolveBps(input.originationFeeBps, BigInt(0));
  const serviceFeeBps = resolveBps(input.serviceFeeBps, BigInt(0));
  const lateFeeBps = resolveBps(input.lateFeeBps, BigInt(0));
  const lateFeeCapBps = resolveBps(input.lateFeeCapBps, DEFAULT_LATE_FEE_CAP_BPS);
  if (
    originationFeeBps === null ||
    serviceFeeBps === null ||
    lateFeeBps === null ||
    lateFeeCapBps === null ||
    !isValidBps(originationFeeBps) ||
    !isValidBps(serviceFeeBps) ||
    !isValidBps(lateFeeBps) ||
    !isValidBps(lateFeeCapBps)
  ) {
    return {
      ok: false,
      error: {
        code: "invalid_fee",
        message: "A fee is outside the supported range.",
        field: "fees",
      },
    };
  }

  // ── Start date ─────────────────────────────────────────────────────────────
  const startDate = input.startDate ?? new Date();
  if (!(startDate instanceof Date) || Number.isNaN(startDate.getTime())) {
    return {
      ok: false,
      error: {
        code: "invalid_date",
        message: "The disbursement date is invalid.",
        field: "startDate",
      },
    };
  }

  // ── Exact arithmetic ───────────────────────────────────────────────────────
  const principal = principalParsed.minor;
  const interest = mulDiv(
    principal,
    annualRateBps * BigInt(termDays),
    BPS_DENOMINATOR * BigInt(DISCLOSURE_DAYS_PER_YEAR),
  );
  const originationFee = mulDiv(principal, originationFeeBps, BPS_DENOMINATOR);
  const serviceFee = mulDiv(principal, serviceFeeBps, BPS_DENOMINATOR);
  const upfrontFees = originationFee + serviceFee;

  if (upfrontFees >= principal) {
    return {
      ok: false,
      error: {
        code: "fees_exceed_principal",
        message: "Upfront fees are greater than or equal to the amount borrowed.",
        field: "fees",
      },
    };
  }

  const amountFinanced = principal - upfrontFees;
  const totalCostOfCredit = interest + upfrontFees;
  const totalRepayment = principal + totalCostOfCredit;
  const dailyLateFee = mulDiv(principal, lateFeeBps, BPS_DENOMINATOR);
  const lateFeeCap = mulDiv(principal, lateFeeCapBps, BPS_DENOMINATOR);

  // Effective APR annualises the *all-in* cost (interest + upfront fees) over
  // the actual term, so a fee-heavy short loan cannot hide behind a low
  // headline rate.
  const effectiveAprBps = Number(
    mulDiv(
      totalCostOfCredit,
      BPS_DENOMINATOR * BigInt(DISCLOSURE_DAYS_PER_YEAR),
      principal * BigInt(termDays),
    ),
  );

  // ── Network fee (disclosed, not financed) ─────────────────────────────────
  let networkFee: NetworkFeeDisclosure | null = null;
  if (input.networkFee) {
    const feeAsset = (input.networkFee.asset ?? "").toUpperCase();
    const feeDecimals = getAssetDecimals(feeAsset);
    const feeParsed = parseDecimalToMinorUnits(input.networkFee.amount ?? "", feeDecimals);
    if (!feeAsset || !feeParsed || feeParsed.minor < BigInt(0)) {
      return {
        ok: false,
        error: {
          code: "invalid_network_fee",
          message: "The estimated network fee is invalid.",
          field: "networkFee",
        },
      };
    }
    networkFee = {
      amount: minorUnitsToCompactDecimal(feeParsed.minor, feeDecimals),
      asset: feeAsset,
      currency: getDisplayCurrency(feeAsset),
    };
  }

  const dueDate = addDaysIso(startDate, termDays);

  // ── Schedule ───────────────────────────────────────────────────────────────
  // A single bullet instalment at maturity. The amortizing per-instalment split
  // shown on the repayment step comes from the backend amortization preview;
  // this local schedule exists so the disclosure still shows a dated obligation
  // when that dependency is unavailable.
  const schedule: LoanCostScheduleRow[] = [
    {
      period: 1,
      dueDate,
      principal: minorUnitsToDecimal(principal, decimals),
      interest: minorUnitsToDecimal(interest, decimals),
      fees: minorUnitsToDecimal(upfrontFees, decimals),
      total: minorUnitsToDecimal(totalRepayment, decimals),
      balance: minorUnitsToDecimal(totalRepayment, decimals),
    },
  ];

  const disclosure: LoanCostDisclosure = {
    asset,
    displayCurrency: getDisplayCurrency(asset),
    decimals,
    principal: minorUnitsToDecimal(principal, decimals),
    amountFinanced: minorUnitsToDecimal(amountFinanced, decimals),
    annualRateBps: Number(annualRateBps),
    effectiveAprBps,
    termDays,
    interest: minorUnitsToDecimal(interest, decimals),
    originationFee: minorUnitsToDecimal(originationFee, decimals),
    serviceFee: minorUnitsToDecimal(serviceFee, decimals),
    upfrontFees: minorUnitsToDecimal(upfrontFees, decimals),
    totalCostOfCredit: minorUnitsToDecimal(totalCostOfCredit, decimals),
    totalRepayment: minorUnitsToDecimal(totalRepayment, decimals),
    dailyLateFee: minorUnitsToDecimal(dailyLateFee, decimals),
    lateFeeCap: minorUnitsToDecimal(lateFeeCap, decimals),
    networkFee,
    dueDate,
    schedule,
    inputRounded: principalParsed.rounded,
    source: "estimate",
    statements: [],
  };

  disclosure.statements = buildStatements(disclosure, input.annualRateBps !== undefined);

  return { ok: true, disclosure };
}

function buildStatements(d: LoanCostDisclosure, explicitRate: boolean): string[] {
  const money = (amount: string) =>
    formatDisclosureAmount(amount, d.asset, { withCurrency: false });
  const statements: string[] = [
    `You borrow ${formatDisclosureAmount(d.principal, d.asset)} over ${d.termDays} days at a nominal annual rate of ${formatBps(d.annualRateBps)}.`,
    `Interest over the full term is ${formatDisclosureAmount(d.interest, d.asset)}; you repay ${formatDisclosureAmount(d.totalRepayment, d.asset)} in total.`,
    `Including every fee, the effective APR (annualised cost of the loan) is ${formatBps(d.effectiveAprBps)}.`,
  ];

  if (!isZeroAmount(d.upfrontFees, d.decimals)) {
    statements.push(
      `Upfront fees of ${formatDisclosureAmount(d.upfrontFees, d.asset)} are deducted before disbursement, so ${formatDisclosureAmount(d.amountFinanced, d.asset)} reaches your wallet.`,
    );
  } else {
    statements.push(
      `There are no upfront origination or service fees; the full ${formatDisclosureAmount(d.principal, d.asset)} is disbursed to your wallet.`,
    );
  }

  if (!isZeroAmount(d.dailyLateFee, d.decimals)) {
    statements.push(
      `A late-payment charge of ${money(d.dailyLateFee)} ${d.asset} applies per day past the due date, capped at ${formatDisclosureAmount(d.lateFeeCap, d.asset)}.`,
    );
  } else {
    statements.push("No late-payment charge is currently configured for this loan.");
  }

  statements.push(
    `The first payment is due on ${d.dueDate}. Payment is not automatic — you must submit it from your wallet.`,
  );
  if (d.networkFee) {
    statements.push(
      `The Stellar network fee of about ${d.networkFee.amount} ${d.networkFee.asset} is paid separately and is not part of the repayment total.`,
    );
  }
  if (!explicitRate) {
    statements.push(
      "Rate shown is the default product rate and may change with protocol governance.",
    );
  }

  return statements;
}

// ─── Reconciliation with the authoritative backend schedule ──────────────────

/**
 * Compare a locally computed disclosure against the backend amortization
 * totals, which are the settlement source of record.
 *
 * A divergence is reported, never silently absorbed: the caller decides
 * whether to display the authoritative numbers or to warn the borrower.
 */
export function reconcileWithAmortization(
  disclosure: LoanCostDisclosure,
  amortization: AmortizationTotalsLike | null | undefined,
  { toleranceMinor = BigInt(1) }: { toleranceMinor?: bigint } = {},
): ReconciliationResult {
  if (!amortization || !disclosure) {
    return {
      status: "unavailable",
      localTotal: disclosure?.totalRepayment ?? "0",
      authoritativeTotal: null,
      delta: null,
      tolerance: "0",
      explanation: "No authoritative schedule is available; showing the local estimate.",
    };
  }

  const authoritativeDue = numberToMinorUnits(amortization.totalDue, disclosure.decimals);
  const authoritativePrincipal = numberToMinorUnits(amortization.principal, disclosure.decimals);
  if (authoritativeDue === null || authoritativePrincipal === null) {
    return {
      status: "unavailable",
      localTotal: disclosure.totalRepayment,
      authoritativeTotal: null,
      delta: null,
      tolerance: toleranceMinor.toString(),
      explanation: "The authoritative schedule returned values that could not be parsed.",
    };
  }

  const localTotalMinor = parseDecimalToMinorUnits(disclosure.totalRepayment, disclosure.decimals);
  if (!localTotalMinor) {
    return {
      status: "unavailable",
      localTotal: disclosure.totalRepayment,
      authoritativeTotal: null,
      delta: null,
      tolerance: toleranceMinor.toString(),
      explanation: "The local estimate could not be parsed.",
    };
  }

  const delta = authoritativeDue - localTotalMinor.minor;
  const magnitude = delta < BigInt(0) ? -delta : delta;

  return {
    status: magnitude <= toleranceMinor ? "matched" : "divergent",
    localTotal: disclosure.totalRepayment,
    authoritativeTotal: minorUnitsToDecimal(authoritativeDue, disclosure.decimals),
    delta: minorUnitsToDecimal(delta, disclosure.decimals),
    tolerance: toleranceMinor.toString(),
    explanation:
      magnitude <= toleranceMinor
        ? "Local estimate matches the authoritative schedule."
        : "The authoritative schedule differs from the local estimate; the authoritative amount is shown.",
  };
}

/**
 * Return a copy of the disclosure whose interest, total cost of credit and
 * total repayment are taken from the authoritative backend schedule, while the
 * locally computed components (fees, effective APR, late-fee terms) are kept
 * for display.
 */
export function applyAuthoritativeTotals(
  disclosure: LoanCostDisclosure,
  amortization: AmortizationTotalsLike | null | undefined,
): LoanCostDisclosure {
  if (!amortization) return { ...disclosure, source: "estimate" };

  const interest = numberToMinorUnits(amortization.totalInterest, disclosure.decimals);
  const totalDue = numberToMinorUnits(amortization.totalDue, disclosure.decimals);
  if (interest === null || totalDue === null) return { ...disclosure, source: "estimate" };

  const interestDecimal = minorUnitsToDecimal(interest, disclosure.decimals);
  const totalDueDecimal = minorUnitsToDecimal(totalDue, disclosure.decimals);
  const costOfCredit =
    interest + parseDecimalToMinorUnits(disclosure.upfrontFees, disclosure.decimals)!.minor;

  const next: LoanCostDisclosure = {
    ...disclosure,
    interest: interestDecimal,
    totalCostOfCredit: minorUnitsToDecimal(costOfCredit, disclosure.decimals),
    totalRepayment: totalDueDecimal,
    source: "authoritative",
  };

  const totalCostMinor = costOfCredit;
  next.effectiveAprBps = Number(
    mulDiv(
      totalCostMinor,
      BPS_DENOMINATOR * BigInt(DISCLOSURE_DAYS_PER_YEAR),
      parseDecimalToMinorUnits(disclosure.principal, disclosure.decimals)!.minor *
        BigInt(disclosure.termDays),
    ),
  );
  next.schedule = [
    {
      period: 1,
      dueDate: disclosure.dueDate,
      principal: disclosure.principal,
      interest: interestDecimal,
      fees: disclosure.upfrontFees,
      total: totalDueDecimal,
      balance: totalDueDecimal,
    },
  ];
  next.statements = buildStatements(next, true);
  return next;
}

/** One-line, screen-reader friendly summary of a disclosure. */
export function summarizeDisclosure(disclosure: LoanCostDisclosure): string {
  return (
    `Borrowing ${formatDisclosureAmount(disclosure.principal, disclosure.asset)} for ${disclosure.termDays} days. ` +
    `Total repayment ${formatDisclosureAmount(disclosure.totalRepayment, disclosure.asset)}, ` +
    `including ${formatDisclosureAmount(disclosure.totalCostOfCredit, disclosure.asset)} of interest and fees. ` +
    `Effective APR ${formatBps(disclosure.effectiveAprBps)}. First payment due ${disclosure.dueDate}.`
  );
}

/** Rows for a disclosure table, in display order. */
export function buildDisclosureRows(
  disclosure: LoanCostDisclosure,
): Array<{ label: string; value: string; emphasis?: "total" | "cost" | "muted" }> {
  const money = (amount: string) => formatDisclosureAmount(amount, disclosure.asset);
  const rows: Array<{ label: string; value: string; emphasis?: "total" | "cost" | "muted" }> = [
    { label: "Amount requested", value: money(disclosure.principal) },
    {
      label: "Amount disbursed to you",
      value: money(disclosure.amountFinanced),
      emphasis: "muted",
    },
    { label: "Interest rate (nominal APR)", value: formatBps(disclosure.annualRateBps) },
    { label: "Term", value: `${disclosure.termDays} days` },
    { label: "Interest over the term", value: money(disclosure.interest), emphasis: "cost" },
  ];

  if (!isZeroAmount(disclosure.upfrontFees, disclosure.decimals)) {
    rows.push(
      { label: "Origination fee", value: money(disclosure.originationFee), emphasis: "cost" },
      { label: "Service fee", value: money(disclosure.serviceFee), emphasis: "cost" },
      {
        label: "Upfront fees (deducted at disbursement)",
        value: money(disclosure.upfrontFees),
        emphasis: "cost",
      },
    );
  }

  rows.push(
    { label: "Total cost of credit", value: money(disclosure.totalCostOfCredit), emphasis: "cost" },
    { label: "Effective APR (all fees included)", value: formatBps(disclosure.effectiveAprBps) },
    { label: "Total repayment", value: money(disclosure.totalRepayment), emphasis: "total" },
    { label: "First payment due", value: disclosure.dueDate },
    {
      label: "Late payment charge",
      value: isZeroAmount(disclosure.dailyLateFee, disclosure.decimals)
        ? "None configured"
        : `${formatDisclosureAmount(disclosure.dailyLateFee, disclosure.asset, { withCurrency: false })} ${disclosure.asset} / day (cap ${money(disclosure.lateFeeCap)})`,
      emphasis: "muted",
    },
  );

  if (disclosure.networkFee) {
    rows.push({
      label: "Network fee (separate, not financed)",
      value: `${disclosure.networkFee.amount} ${disclosure.networkFee.asset}`,
      emphasis: "muted",
    });
  }

  return rows;
}
