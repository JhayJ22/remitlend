import type { Loan, PoolStats } from "../app/hooks/useApi";
import type { OfferRow } from "./offerComparison";

export function buildLoanOfferRows(
  loans: readonly Loan[],
  nameFor: (id: string) => string,
): OfferRow[] {
  return loans.map((loan) => ({
    id: `loan-${loan.id}`,
    name: nameFor(loan.id),
    kind: "loan",
    currency: loan.currency,
    amount: loan.amount,
    ratePercent: loan.interestRate,
    termDays: loan.termDays,
    status: loan.status,
  }));
}

export function buildPoolOfferRows(pool: PoolStats | undefined, name: string): OfferRow[] {
  if (!pool) return [];
  return [
    {
      id: "pool-primary",
      name,
      kind: "pool",
      currency: "USDC",
      amount: pool.totalDeposits,
      ratePercent: pool.apy * 100,
      termDays: pool.withdrawalCooldownLedgers ?? null,
      status: "open",
    },
  ];
}

export function buildOfferRows(
  loans: readonly Loan[],
  pool: PoolStats | undefined,
  nameFor: (id: string) => string,
  poolName: string,
): OfferRow[] {
  return [...buildLoanOfferRows(loans, nameFor), ...buildPoolOfferRows(pool, poolName)];
}
