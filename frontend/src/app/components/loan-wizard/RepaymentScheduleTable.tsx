"use client";

import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { CalendarDays } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/Card";
import type { LoanAmortization, LoanAmortizationScheduleRow } from "../../hooks/useApi";
import { EmptyState } from "../ui/EmptyState";
import { PrintButton } from "../ui/PrintButton";
import {
  computeLoanCostDisclosure,
  formatBps,
  formatDisclosureAmount,
  reconcileWithAmortization,
} from "../../utils/loanCostDisclosure";

function formatMoney(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

interface RepaymentRow {
  period: number;
  timestamp: number;
  dueDate: string;
  total: number;
  interest: number;
  principal: number;
  fee: number;
  balance: number;
}

type SortKey = "timestamp" | "total" | "interest" | "principal" | "fee" | "balance";
type SortDir = "ascending" | "descending";

const COLUMNS: Array<{ key: SortKey; label: string; align: "left" | "right" }> = [
  { key: "timestamp", label: "Payment Date", align: "left" },
  { key: "total", label: "Total Amount", align: "right" },
  { key: "interest", label: "Interest", align: "right" },
  { key: "principal", label: "Principal", align: "right" },
  { key: "fee", label: "Fees", align: "right" },
  { key: "balance", label: "Remaining Balance", align: "right" },
];

function mapScheduleRows(rows: LoanAmortizationScheduleRow[]): RepaymentRow[] {
  return rows.map((row, index) => ({
    period: index + 1,
    timestamp: new Date(row.date).getTime(),
    dueDate: formatDate(new Date(row.date)),
    total: row.totalDue,
    interest: row.interestPortion,
    principal: row.principalPortion,
    fee: row.feePortion ?? 0,
    balance: row.runningBalance,
  }));
}

interface RepaymentScheduleTableProps {
  amortization: LoanAmortization;
  title?: string;
  description?: string;
  compact?: boolean;
  showSummaryCards?: boolean;
}

export function RepaymentScheduleTable({
  amortization,
  title = "Repayment Schedule",
  description = "Review how each payment is split across the life of the loan.",
  compact = false,
  showSummaryCards = true,
}: RepaymentScheduleTableProps) {
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir } | null>(null);
  const baseSchedule = useMemo(() => mapScheduleRows(amortization.schedule), [amortization.schedule]);
  const schedule = useMemo(() => {
    if (!sort) return baseSchedule;
    const factor = sort.dir === "ascending" ? 1 : -1;
    return [...baseSchedule].sort((a, b) => (a[sort.key] - b[sort.key]) * factor);
  }, [baseSchedule, sort]);
  const totals = useMemo(
    () =>
      baseSchedule.reduce(
        (acc, row) => ({
          total: acc.total + row.total,
          interest: acc.interest + row.interest,
          principal: acc.principal + row.principal,
          fee: acc.fee + row.fee,
        }),
        { total: 0, interest: 0, principal: 0, fee: 0 },
      ),
    [baseSchedule],
  );

  const toggleSort = (key: SortKey) =>
    setSort((prev) =>
      prev?.key === key
        ? { key, dir: prev.dir === "ascending" ? "descending" : "ascending" }
        : { key, dir: "ascending" },
    );

  /**
   * The cost of credit is derived from the *authoritative* schedule totals via
   * the shared disclosure engine, so the effective APR shown here is the same
   * arithmetic used on the signature step rather than a second implementation.
   */
  const costDisclosure = useMemo(() => {
    const termDays = Math.max(1, Math.round(amortization.termLedgers / 17280));
    const result = computeLoanCostDisclosure({
      principal: String(amortization.principal ?? 0),
      asset: "USDC",
      termDays,
      annualRateBps: amortization.interestRateBps ?? 0,
    });
    if (!result.ok) return null;
    return result.disclosure;
  }, [amortization.principal, amortization.termLedgers, amortization.interestRateBps]);

  const reconciliation = useMemo(
    () => (costDisclosure ? reconcileWithAmortization(costDisclosure, amortization) : undefined),
    [costDisclosure, amortization],
  );

  return (
    <Card>
      <CardHeader className={compact ? "pb-4" : undefined}>
        <CardTitle className="flex items-center gap-2 text-lg">
          <CalendarDays className="h-5 w-5 text-indigo-500" />
          {title}
        </CardTitle>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">{description}</p>
        {schedule.length > 0 && (
          <div>
            <PrintButton label="Print schedule" documentTitle="RemitLend - Repayment Schedule" />
          </div>
        )}
      </CardHeader>
      <CardContent className={compact ? "space-y-4" : "space-y-6"}>
        {showSummaryCards && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
              <p className="text-xs text-zinc-500 dark:text-zinc-400">Principal Total</p>
              <p className="mt-0.5 font-semibold text-zinc-900 dark:text-zinc-50">
                {formatMoney(amortization.principal)}
              </p>
            </div>
            <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
              <p className="text-xs text-zinc-500 dark:text-zinc-400">Total Interest</p>
              <p className="mt-0.5 font-semibold text-zinc-900 dark:text-zinc-50">
                {formatMoney(amortization.totalInterest)}
              </p>
            </div>
            <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-3 dark:border-indigo-900/50 dark:bg-indigo-950/30">
              <p className="text-xs text-indigo-600 dark:text-indigo-400">Total Cost of Loan</p>
              <p className="mt-0.5 font-semibold text-indigo-700 dark:text-indigo-300">
                {formatMoney(amortization.totalDue)}
              </p>
              {costDisclosure && (
                <p
                  data-testid="repayment-schedule-effective-apr"
                  className="mt-1 text-[11px] text-indigo-700 dark:text-indigo-300"
                >
                  Effective APR {formatBps(costDisclosure.effectiveAprBps)} (
                  {formatDisclosureAmount(costDisclosure.totalCostOfCredit, costDisclosure.asset)}{" "}
                  of interest and fees)
                </p>
              )}
            </div>
          </div>
        )}

        {reconciliation && reconciliation.status === "divergent" && (
          <p
            role="status"
            data-testid="repayment-schedule-reconciliation-warning"
            className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300"
          >
            {reconciliation.explanation} The on-chain schedule above is the binding amount.
          </p>
        )}

        {schedule.length === 0 ? (
          <EmptyState
            icon={CalendarDays}
            title="No repayment schedule available"
            description="Generate or load a loan preview to see installment dates and balances."
          />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
            <table className="w-full text-sm">
              <caption className="sr-only">
                Repayment schedule with interest, principal and fee breakdown for each payment
              </caption>
              <thead>
                <tr className="border-b border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900">
                  {COLUMNS.map((col) => {
                    const active = sort?.key === col.key ? sort.dir : "none";
                    const Icon =
                      active === "ascending" ? ArrowUp : active === "descending" ? ArrowDown : ArrowUpDown;
                    return (
                      <th
                        key={col.key}
                        scope="col"
                        aria-sort={active}
                        className={`px-4 py-3 font-medium text-zinc-600 dark:text-zinc-400 ${
                          col.align === "right" ? "text-right" : "text-left"
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => toggleSort(col.key)}
                          className="inline-flex items-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                        >
                          {col.label}
                          <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {schedule.map((row) => (
                  <tr key={row.period} className="border-b border-zinc-100 dark:border-zinc-800/50">
                    <th
                      scope="row"
                      className="px-4 py-3 text-left font-normal text-zinc-900 dark:text-zinc-50"
                    >
                      {row.dueDate}
                    </th>
                    <td className="px-4 py-3 text-right font-semibold text-zinc-900 dark:text-zinc-50">
                      {formatMoney(row.total)}
                    </td>
                    <td className="px-4 py-3 text-right text-amber-600 dark:text-amber-400">
                      {formatMoney(row.interest)}
                    </td>
                    <td className="px-4 py-3 text-right text-zinc-900 dark:text-zinc-50">
                      {formatMoney(row.principal)}
                    </td>
                    <td className="px-4 py-3 text-right text-zinc-900 dark:text-zinc-50">
                      {formatMoney(row.fee)}
                    </td>
                    <td className="px-4 py-3 text-right text-zinc-500 dark:text-zinc-400">
                      {formatMoney(row.balance)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr
                  data-testid="repayment-schedule-totals"
                  className="bg-zinc-50 font-semibold dark:bg-zinc-900"
                >
                  <th scope="row" className="px-4 py-3 text-left text-zinc-700 dark:text-zinc-300">
                    Totals
                  </th>
                  <td className="px-4 py-3 text-right text-indigo-600 dark:text-indigo-400">
                    {formatMoney(totals.total)}
                  </td>
                  <td className="px-4 py-3 text-right">{formatMoney(totals.interest)}</td>
                  <td className="px-4 py-3 text-right">{formatMoney(totals.principal)}</td>
                  <td className="px-4 py-3 text-right">{formatMoney(totals.fee)}</td>
                  <td className="px-4 py-3" />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
