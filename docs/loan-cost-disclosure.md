# Loan Cost & Fee Disclosure

How RemitLend shows a borrower the **complete** cost of a loan before they sign, and the rules contributors must follow when changing anything in that path.

Addresses issue [#320](https://github.com/JhayJ22/remitlend/issues/320).

---

## 1. Why this exists

Before this change the loan wizard showed an APR, a principal and a "Total Repayment" that were computed inline in the signature step with `principal * 12 * termDays / 36500`. That number:

- was derived from a `number` multiplication, so it could not be reconciled with the settlement amount on chain;
- omitted every fee except a hard-coded network estimate;
- hard-coded the interest rate in three different files, so the disclosed rate and the submitted rate could drift apart;
- never showed the *effective* rate — a loan with a large origination fee and a low headline APR looked cheaper than it was.

The disclosure engine replaces that with one exact-math implementation used by every surface.

---

## 2. The engine

`frontend/src/app/utils/loanCostDisclosure.ts`

| Export | Purpose |
|---|---|
| `computeLoanCostDisclosure(input)` | Pure function: loan terms in, complete disclosure out, or a typed error. Never throws. |
| `buildDisclosureRows(d)` | Display rows for a table, in a stable order. |
| `summarizeDisclosure(d)` | One-line summary for screen readers and toasts. |
| `reconcileWithAmortization(d, amort)` | Compares the local estimate with the backend schedule. |
| `applyAuthoritativeTotals(d, amort)` | Returns a disclosure whose totals come from the backend. |
| `formatBps`, `formatDisclosureAmount`, `addDaysIso`, `isZeroAmount` | Formatting helpers. |
| `parseDecimalToMinorUnits`, `minorUnitsToDecimal`, `mulDiv`, `divRoundHalfUp`, `numberToMinorUnits` | Exact bigint arithmetic. |
| `DEFAULT_LOAN_ANNUAL_RATE_BPS` | The single source of truth for the product rate (`1200` = 12 %). |

### Exact arithmetic, by rule

1. **Money is `bigint` minor units.** Never a `number`. `1000 USDC` is `100000n`.
2. **Rates are integer basis points.** `1200n` = 12 %. `12.5 %` is `1250n`.
3. **One rounding rule.** `divRoundHalfUp` — half away from zero — applied once, at the asset's own precision, and only at the end of a computation. Intermediate products are never rounded.
4. **The total is always the sum of the displayed components.** The panel renders the components and the total from the same disclosure object, so they cannot disagree.

```
principal + interest + originationFee + serviceFee === totalRepayment
```

This invariant is asserted in `loanCostDisclosure.test.ts`.

### Validation and bounds

`computeLoanCostDisclosure` returns `{ ok: false, error }` — never a throw, never a `NaN`:

| Code | Trigger |
|---|---|
| `invalid_principal` | Non-numeric, zero, negative, over-length, exponent form, signed, or missing asset. |
| `invalid_term` | Non-integer, `< 1`, or `> 1825` days. |
| `invalid_rate` | Rate outside `0 … 100 000` bps. |
| `invalid_fee` | A fee outside the same range. |
| `fees_exceed_principal` | Upfront fees `>=` principal (nothing would be disbursed). |
| `invalid_network_fee` | Malformed network fee or unknown fee asset. |
| `invalid_date` | Unparseable `startDate`. |

Bounded resources: amount strings are capped at `MAX_DISCLOSURE_INPUT_LENGTH` (40 chars), terms at `MAX_DISCLOSURE_TERM_DAYS` (1825), and the disclosure always contains at most one schedule row. There is no loop over a caller-supplied length, so a corrupt input cannot turn a render into an unbounded operation.

---

## 3. Authoritative source of truth

The **lending pool amortization** returned by `GET /loans/amortization-preview` is the settlement record. The local computation is an estimate.

- `reconcileWithAmortization` compares them in minor units with a tolerance of one minor unit and returns `matched`, `divergent` or `unavailable`.
- `applyAuthoritativeTotals` produces the disclosure actually rendered: interest, cost of credit and total repayment come from the server; the locally computed components (fees, effective APR, late-fee terms, due date) are kept because the server does not return them.
- A divergence is **surfaced**, never silently absorbed. The panel renders a warning naming the on-chain schedule as binding.

The signature step reads the amortization through `useLoanAmortizationPreview`, which is already cached from the repayment step, so the comparison is normally a cache hit and costs no extra request.

> If the preview is unavailable the panel shows the local estimate and says so
> (`data-testid="loan-cost-reconciliation-stale"`). It never shows a partial
> breakdown, and it never disables itself silently.

---

## 4. What the borrower sees

`frontend/src/app/components/loan/LoanCostDisclosurePanel.tsx`

- **Amount requested** and **amount disbursed to you** — these differ whenever an upfront fee is deducted, which was previously invisible.
- **Interest rate (nominal APR)** — the rate that is actually charged.
- **Interest over the term**, and each fee named individually (origination, service).
- **Total cost of credit** = interest + upfront fees.
- **Effective APR (all fees included)** — the headline number that annualises the all-in cost over the actual term. It is always `>=` the nominal APR.
- **Total repayment**, **first payment due**, and the **late-payment charge with its cap**.
- **Network fee** shown separately and labelled "not financed", because it is paid in XLM and is not repaid with the loan.
- Plain-language statements rendered verbatim, including a screen-reader-only summary.

`LoanCostDisclosureError` renders a typed failure instead of a broken panel. When the cost cannot be computed, `StepFinalSignature` disables **Sign & Submit** — a borrower is never asked to sign a request whose cost is unknown.

### Surfaces

| Surface | What it shows |
|---|---|
| `StepAmountAsset` | Live cost preview (interest, upfront fees, total you repay) and the effective APR next to the nominal one, updating as the amount or term changes. |
| `StepRepaymentSchedule` / `RepaymentScheduleTable` | Effective APR derived from the authoritative schedule, plus a divergence warning. |
| `StepFinalSignature` | The full panel, and the same line items in the transaction preview modal that the wallet signs. |
| `TransactionPreviewModal` | `details` now carry amount received, nominal APR, effective APR, interest, fees, cost of credit and total repayment. |

---

## 5. Compatibility

- **Contracts:** unchanged. No contract, contract call or ledger entry is touched.
- **API:** unchanged. The new code only *reads* the existing amortization-preview response.
- **Persisted data:** unchanged. Nothing is written to storage.
- **Behavioural change:** the disclosed "Total Repayment" and APR on the signature step now come from the exact engine and the authoritative schedule. Where the old inline float maths disagreed with the server by a fraction of a cent, the server value is now shown. Interest is still submitted at `DEFAULT_LOAN_ANNUAL_RATE_BPS / 100`, i.e. the same 12 % as before.

### Rollout

1. Merge behind the existing wizard (no feature flag required — the panel is additive).
2. Verify the disclosed total matches `/loans/amortization-preview` for a live loan request.
3. Confirm the effective APR reads `>=` the nominal APR for 30/60/90-day terms.
4. Rollback: revert the commit. There is no persisted state, no migration and no contract change, so rollback is a pure deploy revert.

---

## 6. Threat model notes

| Threat | Mitigation |
|---|---|
| **Misleading cost disclosure** — a borrower signs believing the loan is cheaper than it is. | Effective APR is always shown next to the nominal rate; the total is the exact sum of the disclosed components; server totals override local ones on divergence. |
| **Float rounding drift** — a float-derived total that does not match settlement. | All arithmetic is `bigint`; `number` only ever appears after `toFixed(decimals)` for display. |
| **Attacker-controlled input** — a crafted amount string that hangs or corrupts the render. | Length/term/rate caps, a strict numeric grammar, and a non-throwing typed error for everything else. |
| **Fee evasion** — a fee that is charged but not disclosed. | The engine is the only place fees are computed, and the disclosure is built from the same object that feeds the transaction preview. |
| **Stale data** — the disclosure is computed from an old amount. | The disclosure is derived from the current wizard state on every render; reconciliation against the server runs on the same render. |

---

## 7. Testing

```bash
cd frontend
npx jest src/app/utils/loanCostDisclosure.test.ts
npx jest src/app/components/loan/__tests__/LoanCostDisclosurePanel.test.tsx
```

`loanCostDisclosure.test.ts` covers: exact rounding (half-up, sign, zero-denominator guard), decimal parsing including malformed/exponential/over-length input, the interest and fee formulas, the effective-APR annualisation across terms, every typed error code, hostile input (`undefined`, `null`, 5 000-digit strings, `Number.MAX_SAFE_INTEGER`), all three reconciliation states, immutability of `applyAuthoritativeTotals`, and the formatting helpers.

`LoanCostDisclosurePanel.test.tsx` covers: itemisation, nominal vs effective APR, the total-equals-sum invariant, due date, the separate network fee, suppression of zero-fee rows, the rounding notice, the estimate/authoritative badge, the divergence warning, the stale-schedule notice, the screen-reader summary, and the typed-error component.

---

## 8. Related documentation

- [Risk Disclosure](risk-disclosure.md) — the borrower-facing risk surface.
- [Wallet Transaction UX](wallet-transaction-ux.md) — signing, preview and polling rules.
- [Transaction Recovery UX](transaction-recovery-ux.md) — what happens when a request is rejected or expires.
- [Architecture](../ARCHITECTURE.md)
