import { roundToCents } from '../money/decimal.js';

/** Seconds per closed ledger, used when deriving deadlines from ledger heights. */
export const LEDGER_CLOSE_SECONDS = 5;
/** Default loan term in ledgers when an approval event does not specify one (1 day). */
export const DEFAULT_TERM_LEDGERS = 17280;
/** Default annualised interest rate (basis points) when unspecified (12%). */
export const DEFAULT_INTEREST_RATE_BPS = 1200;

interface AmortizationPeriod {
  date: string;
  principalPortion: number;
  interestPortion: number;
  totalDue: number;
  runningBalance: number;
}

export interface AmortizationSchedule {
  principal: number;
  interestRateBps: number;
  termLedgers: number;
  totalInterest: number;
  totalDue: number;
  schedule: AmortizationPeriod[];
}

const addDays = (date: Date, days: number): Date => {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
};

/**
 * Build an amortization schedule for a loan given its principal, interest rate
 * (basis points) and term (ledgers). Pure function extracted from
 * loanController into this service (issue #41).
 */
export const buildAmortizationSchedule = (
  principal: number,
  interestRateBps: number,
  termLedgers: number,
  startDate: Date,
): AmortizationSchedule => {
  const totalInterest = principal * (interestRateBps / 10_000);
  const totalDue = principal + totalInterest;

  const LEDGER_DAY = 17280; // 1 day in ledgers
  const termDays = termLedgers / LEDGER_DAY;

  const periodCount = Math.max(1, Math.round(termDays / 30) || 1);
  const daysPerPeriod = termDays / periodCount;

  const rawPrincipalPortion = principal / periodCount;
  const rawInterestPortion = totalInterest / periodCount;

  const schedule: AmortizationPeriod[] = [];

  let remainingPrincipal = principal;
  let remainingInterest = totalInterest;

  for (let i = 1; i <= periodCount; i++) {
    const isLast = i === periodCount;

    const principalPortion = isLast
      ? roundToCents(remainingPrincipal)
      : roundToCents(rawPrincipalPortion);

    const interestPortion = isLast
      ? roundToCents(remainingInterest)
      : roundToCents(rawInterestPortion);

    remainingPrincipal = roundToCents(remainingPrincipal - principalPortion);
    remainingInterest = roundToCents(remainingInterest - interestPortion);

    const dueDate = addDays(startDate, Math.round(daysPerPeriod * i));

    schedule.push({
      date: dueDate.toISOString(),
      principalPortion,
      interestPortion,
      totalDue: roundToCents(principalPortion + interestPortion),
      runningBalance: Math.max(0, remainingPrincipal),
    });
  }

  return {
    principal: roundToCents(principal),
    interestRateBps,
    termLedgers,
    totalInterest: roundToCents(totalInterest),
    totalDue: roundToCents(totalDue),
    schedule,
  };
};
