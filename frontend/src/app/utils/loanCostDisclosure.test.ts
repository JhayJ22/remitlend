const bn = (value: number): bigint => BigInt(value);

import {
  addDaysIso,
  applyAuthoritativeTotals,
  buildDisclosureRows,
  computeLoanCostDisclosure,
  DEFAULT_LATE_FEE_CAP_BPS,
  divRoundHalfUp,
  formatBps,
  formatDisclosureAmount,
  isZeroAmount,
  MAX_DISCLOSURE_INPUT_LENGTH,
  minorUnitsToCompactDecimal,
  minorUnitsToDecimal,
  mulDiv,
  parseDecimalToMinorUnits,
  reconcileWithAmortization,
  summarizeDisclosure,
  type LoanCostInput,
} from "./loanCostDisclosure";

const BASE: LoanCostInput = {
  principal: "1000",
  asset: "USDC",
  termDays: 30,
  annualRateBps: 1200,
  lateFeeBps: 50,
  startDate: new Date("2026-01-01T00:00:00.000Z"),
};

function ok(input: Partial<LoanCostInput> = {}) {
  const result = computeLoanCostDisclosure({ ...BASE, ...input });
  if (!result.ok) {
    throw new Error(`expected a disclosure, got error: ${result.error.code}`);
  }
  return result.disclosure;
}

function err(input: Partial<LoanCostInput> = {}) {
  const result = computeLoanCostDisclosure({ ...BASE, ...input });
  if (result.ok) {
    throw new Error("expected a typed error, got a disclosure");
  }
  return result.error;
}

describe("loanCostDisclosure — exact arithmetic helpers", () => {
  it("rounds half-up and keeps sign", () => {
    expect(divRoundHalfUp(bn(5), bn(2))).toBe(bn(3));
    expect(divRoundHalfUp(bn(4), bn(2))).toBe(bn(2));
    expect(divRoundHalfUp(bn(1), bn(3))).toBe(bn(0));
    expect(divRoundHalfUp(-bn(5), bn(2))).toBe(-bn(3));
  });

  it("rejects a non-positive denominator instead of producing garbage", () => {
    expect(() => divRoundHalfUp(bn(1), bn(0))).toThrow(/positive denominator/);
  });

  it("computes mulDiv exactly", () => {
    expect(mulDiv(bn(1_000), bn(3), bn(4))).toBe(bn(750));
  });

  it("parses decimal strings into minor units exactly", () => {
    expect(parseDecimalToMinorUnits("1", 2)).toEqual({ minor: bn(100), rounded: false });
    expect(parseDecimalToMinorUnits("1.5", 2)).toEqual({ minor: bn(150), rounded: false });
    expect(parseDecimalToMinorUnits("0.0000001", 7)).toEqual({ minor: bn(1), rounded: false });
  });

  it("rounds half-up when the input exceeds the asset precision, and flags it", () => {
    expect(parseDecimalToMinorUnits("1.005", 2)).toEqual({ minor: bn(101), rounded: true });
    expect(parseDecimalToMinorUnits("1.004", 2)).toEqual({ minor: bn(100), rounded: true });
  });

  it("rejects malformed, signed, exponential and empty amounts", () => {
    for (const bad of ["", "  ", "abc", "-1", "+1", "1e3", "1,000", "1.2.3", "0x10", "."]) {
      expect(parseDecimalToMinorUnits(bad, 2)).toBeNull();
    }
  });

  it("bounds input length", () => {
    expect(parseDecimalToMinorUnits("1".repeat(MAX_DISCLOSURE_INPUT_LENGTH), 2)).not.toBeNull();
    expect(parseDecimalToMinorUnits("1".repeat(MAX_DISCLOSURE_INPUT_LENGTH + 1), 2)).toBeNull();
  });

  it("round-trips minor units through the decimal string", () => {
    expect(minorUnitsToDecimal(bn(123456), 2)).toBe("1234.56");
    expect(minorUnitsToDecimal(bn(1), 7)).toBe("0.0000001");
    expect(minorUnitsToDecimal(bn(5), 0)).toBe("5");
    expect(minorUnitsToDecimal(-bn(150), 2)).toBe("-1.50");
  });
});

describe("computeLoanCostDisclosure — success paths", () => {
  it("uses a 100% of principal default late-fee cap", () => {
    expect(DEFAULT_LATE_FEE_CAP_BPS).toBe(bn(10_000));
  });

  it("computes interest, total cost and total repayment for a 30 day USDC loan", () => {
    const d = ok();
    // 1000 * 12% * 30 / 365 = 9.8630... -> 9.86
    expect(d.interest).toBe("9.86");
    expect(d.totalCostOfCredit).toBe("9.86");
    expect(d.totalRepayment).toBe("1009.86");
    expect(d.amountFinanced).toBe("1000.00");
  });

  it("keeps the total equal to the sum of the disclosed components", () => {
    const d = ok({ principal: "12345.67", termDays: 90, annualRateBps: 1750 });
    const sum =
      Number(d.principal) + Number(d.interest) + Number(d.originationFee) + Number(d.serviceFee);
    expect(Number(d.totalRepayment)).toBeCloseTo(sum, 2);
  });

  it("charges fees and reduces the amount disbursed", () => {
    const d = ok({ originationFeeBps: 100, serviceFeeBps: 25 });
    expect(d.originationFee).toBe("10.00");
    expect(d.serviceFee).toBe("2.50");
    expect(d.upfrontFees).toBe("12.50");
    expect(d.amountFinanced).toBe("987.50");
    expect(d.totalCostOfCredit).toBe("22.36");
    expect(d.totalRepayment).toBe("1022.36");
  });

  it("annualises the all-in cost into an effective APR", () => {
    const withFees = ok({ originationFeeBps: 500, termDays: 30 });
    // 5% fee on 30 days annualises to far more than the 12% headline rate.
    expect(withFees.effectiveAprBps).toBeGreaterThan(withFees.annualRateBps);
    const feeFree = ok({ termDays: 30 });
    expect(feeFree.effectiveAprBps).toBeGreaterThanOrEqual(1200);
    expect(feeFree.effectiveAprBps).toBeLessThan(1201);
  });

  it("annualises to the same rate regardless of term length", () => {
    const short = ok({ termDays: 30 });
    const long = ok({ termDays: 360 });
    expect(Math.abs(short.effectiveAprBps - long.effectiveAprBps)).toBeLessThanOrEqual(1);
  });

  it("discloses the late fee, its cap and the first due date", () => {
    const d = ok();
    expect(d.dailyLateFee).toBe("5.00");
    // Default cap is 100% of principal.
    expect(d.lateFeeCap).toBe("1000.00");
    expect(d.dueDate).toBe("2026-01-31");
  });

  it("treats a zero late fee as no late fee", () => {
    const d = ok({ lateFeeBps: 0 });
    expect(isZeroAmount(d.dailyLateFee, d.decimals)).toBe(true);
    expect(d.statements.join(" ")).toContain("No late-payment charge");
  });

  it("discloses the network fee separately from the loan total", () => {
    const d = ok({ networkFee: { amount: "0.00001", asset: "XLM" } });
    expect(d.networkFee).toEqual({ amount: "0.00001", asset: "XLM", currency: "XLM" });
    expect(d.totalRepayment).toBe("1009.86");
    expect(d.statements.join(" ")).toContain("not part of the repayment total");
  });

  it("supports 7-decimal assets without float drift", () => {
    const d = ok({ principal: "0.1234567", asset: "XLM", annualRateBps: 1200 });
    // 1234567 * 1200 * 30 / (10000 * 365) = 12176.55... stroops -> 12177
    expect(d.interest).toBe("0.0012177");
    expect(d.totalRepayment).toBe("0.1246744");
  });

  it("flags when the entered amount was rounded to the asset precision", () => {
    const d = ok({ principal: "1000.005" });
    expect(d.inputRounded).toBe(true);
    expect(d.principal).toBe("1000.01");
  });

  it("produces a single dated obligation in the local schedule", () => {
    const d = ok();
    expect(d.schedule).toHaveLength(1);
    expect(d.schedule[0]).toMatchObject({ period: 1, dueDate: "2026-01-31" });
  });

  it("emits plain-language statements including the effective APR", () => {
    const d = ok();
    expect(d.statements.join(" ")).toContain("12.00%");
    expect(d.statements.join(" ")).toContain("effective");
  });
});

describe("computeLoanCostDisclosure — validation and boundedness", () => {
  it("rejects a non-numeric principal", () => {
    expect(err({ principal: "abc" }).code).toBe("invalid_principal");
  });

  it("rejects a zero or negative principal", () => {
    expect(err({ principal: "0" }).code).toBe("invalid_principal");
    expect(err({ principal: "-5" }).code).toBe("invalid_principal");
  });

  it("rejects a fractional or out-of-range term", () => {
    expect(err({ termDays: 0 }).code).toBe("invalid_term");
    expect(err({ termDays: 30.5 }).code).toBe("invalid_term");
    expect(err({ termDays: -30 }).code).toBe("invalid_term");
    expect(err({ termDays: 100_000 }).code).toBe("invalid_term");
  });

  it("accepts the boundary terms", () => {
    expect(ok({ termDays: 1 }).termDays).toBe(1);
    expect(ok({ termDays: 1825 }).termDays).toBe(1825);
  });

  it("rejects out-of-range rates and fees", () => {
    expect(err({ annualRateBps: -1 }).code).toBe("invalid_rate");
    expect(err({ annualRateBps: 1_000_000 }).code).toBe("invalid_rate");
    expect(err({ originationFeeBps: -5 }).code).toBe("invalid_fee");
  });

  it("rejects fees that consume the whole principal", () => {
    const e = err({ originationFeeBps: 10_000 });
    expect(e.code).toBe("fees_exceed_principal");
    expect(e.field).toBe("fees");
  });

  it("rejects a malformed network fee", () => {
    expect(err({ networkFee: { amount: "free", asset: "XLM" } }).code).toBe("invalid_network_fee");
    expect(err({ networkFee: { amount: "1", asset: "" } }).code).toBe("invalid_network_fee");
  });

  it("rejects an invalid start date", () => {
    expect(err({ startDate: new Date("nope") }).code).toBe("invalid_date");
  });

  it("rejects a missing asset", () => {
    expect(err({ asset: "" }).code).toBe("invalid_principal");
  });

  it("never throws on hostile input", () => {
    const inputs = [
      undefined,
      null,
      {},
      { ...BASE, principal: "9".repeat(5000) },
      { ...BASE, principal: "1".repeat(39) + ".99" },
      { ...BASE, termDays: Number.MAX_SAFE_INTEGER },
      { ...BASE, annualRateBps: Number.NaN },
    ] as unknown as LoanCostInput[];
    for (const input of inputs) {
      expect(() => computeLoanCostDisclosure(input)).not.toThrow();
      expect(computeLoanCostDisclosure(input).ok).toBe(false);
    }
  });
});

describe("reconcileWithAmortization", () => {
  it("reports unavailable when the authoritative schedule is missing", () => {
    const result = reconcileWithAmortization(ok(), null);
    expect(result.status).toBe("unavailable");
    expect(result.authoritativeTotal).toBeNull();
    expect(result.localTotal).toBe("1009.86");
  });

  it("reports unavailable when the authoritative totals cannot be parsed", () => {
    const result = reconcileWithAmortization(ok(), {
      principal: Number.NaN,
      totalInterest: Number.NaN,
      totalDue: Number.NaN,
    });
    expect(result.status).toBe("unavailable");
  });

  it("matches within tolerance", () => {
    const result = reconcileWithAmortization(ok(), {
      principal: 1000,
      totalInterest: 9.86,
      totalDue: 1009.86,
    });
    expect(result.status).toBe("matched");
    expect(result.delta).toBe("0.00");
  });

  it("flags a divergence with a signed delta", () => {
    const result = reconcileWithAmortization(ok(), {
      principal: 1000,
      totalInterest: 5,
      totalDue: 1005,
    });
    expect(result.status).toBe("divergent");
    expect(result.delta).toBe("-4.86");
    expect(result.explanation).toMatch(/authoritative/);
  });

  it("honours a custom tolerance", () => {
    const result = reconcileWithAmortization(
      ok(),
      { principal: 1000, totalInterest: 9, totalDue: 1009 },
      { toleranceMinor: bn(100) },
    );
    expect(result.status).toBe("matched");
  });
});

describe("applyAuthoritativeTotals", () => {
  it("prefers the server totals and marks the source authoritative", () => {
    const local = ok();
    const applied = applyAuthoritativeTotals(local, {
      principal: 1000,
      totalInterest: 12.5,
      totalDue: 1012.5,
    });
    expect(applied.source).toBe("authoritative");
    expect(applied.interest).toBe("12.50");
    expect(applied.totalRepayment).toBe("1012.50");
    expect(applied.totalCostOfCredit).toBe("12.50");
    expect(applied.schedule[0].total).toBe("1012.50");
  });

  it("adds upfront fees to the authoritative interest when computing cost of credit", () => {
    const local = ok({ originationFeeBps: 100 });
    const applied = applyAuthoritativeTotals(local, {
      principal: 1000,
      totalInterest: 12.5,
      totalDue: 1012.5,
    });
    expect(applied.totalCostOfCredit).toBe("22.50");
  });

  it("falls back to the estimate when the server totals are unusable", () => {
    const local = ok();
    const applied = applyAuthoritativeTotals(local, {
      principal: Number.NaN,
      totalInterest: Number.NaN,
      totalDue: Number.NaN,
    });
    expect(applied.source).toBe("estimate");
    expect(applied.totalRepayment).toBe(local.totalRepayment);
  });

  it("does not mutate the input disclosure", () => {
    const local = ok();
    applyAuthoritativeTotals(local, { principal: 1000, totalInterest: 99, totalDue: 1099 });
    expect(local.totalRepayment).toBe("1009.86");
    expect(local.source).toBe("estimate");
  });
});

describe("formatting helpers", () => {
  it("formats basis points as a percentage", () => {
    expect(formatBps(1200)).toBe("12.00%");
    expect(formatBps(1750)).toBe("17.50%");
    expect(formatBps(Number.NaN)).toBe("—");
  });

  it("formats disclosure amounts with the asset currency", () => {
    expect(formatDisclosureAmount("1009.86", "USDC")).toContain("1,009.86");
    expect(formatDisclosureAmount("1009.86", "USDC")).toContain("$");
  });

  it("omits the currency symbol when asked for a bare number", () => {
    expect(formatDisclosureAmount("1009.86", "USDC", { withCurrency: false })).toBe("1,009.86");
  });

  it("falls back gracefully for a non-numeric amount", () => {
    expect(formatDisclosureAmount("n/a", "USDC")).toBe("n/a USDC");
    expect(formatDisclosureAmount("n/a", "USDC", { withCurrency: false })).toBe("n/a");
  });

  it("adds days and returns an ISO date", () => {
    expect(addDaysIso(new Date("2026-01-01T00:00:00.000Z"), 30)).toBe("2026-01-31");
  });

  it("summarises a disclosure for screen readers", () => {
    const summary = summarizeDisclosure(ok());
    expect(summary).toContain("1,000.00");
    expect(summary).toContain("30 days");
    expect(summary).toContain("2026-01-31");
  });

  it("builds display rows in a stable order with the total emphasised", () => {
    const rows = buildDisclosureRows(ok({ originationFeeBps: 100 }));
    const labels = rows.map((r) => r.label);
    expect(labels[0]).toBe("Amount requested");
    expect(labels).toContain("Origination fee");
    expect(labels).toContain("Effective APR (all fees included)");
    const total = rows.find((r) => r.label === "Total repayment");
    expect(total?.emphasis).toBe("total");
  });

  it("omits zero fee rows and reports a configured late fee", () => {
    const rows = buildDisclosureRows(ok());
    expect(rows.some((r) => r.label === "Origination fee")).toBe(false);
    expect(rows.find((r) => r.label === "Late payment charge")?.value).toContain("/ day");
  });

  it("reports no late fee when none is configured", () => {
    const rows = buildDisclosureRows(ok({ lateFeeBps: 0 }));
    expect(rows.find((r) => r.label === "Late payment charge")?.value).toBe("None configured");
  });

  it("trims insignificant zeros from the compact network fee amount", () => {
    expect(minorUnitsToCompactDecimal(bn(100), 7)).toBe("0.00001");
    expect(minorUnitsToCompactDecimal(bn(5), 2)).toBe("0.05");
    expect(minorUnitsToCompactDecimal(bn(0), 2)).toBe("0.0");
  });
});
