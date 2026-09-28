"use client";

import { CircleAlert, Info, ReceiptText, ShieldCheck } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/Card";
import {
  buildDisclosureRows,
  formatBps,
  formatDisclosureAmount,
  summarizeDisclosure,
  type DisclosureSource,
  type LoanCostDisclosure,
  type LoanCostError,
  type ReconciliationResult,
} from "../../utils/loanCostDisclosure";

interface LoanCostDisclosurePanelProps {
  disclosure: LoanCostDisclosure;
  /** Result of comparing the local estimate to the backend schedule, if any. */
  reconciliation?: ReconciliationResult;
  title?: string;
  description?: string;
  /** Render a denser variant for side panels. */
  compact?: boolean;
}

/**
 * Renders the borrower-facing cost of credit: every fee is named, the nominal
 * rate and the all-in effective APR are both shown, and the total repayment is
 * always the sum of the disclosed components. When the backend schedule is
 * available the panel marks itself as authoritative and reports any divergence
 * from the local estimate instead of hiding it.
 */
export function LoanCostDisclosurePanel({
  disclosure,
  reconciliation,
  title = "Cost of Loan Disclosure",
  description = "Every amount you pay on this loan, itemised.",
  compact = false,
}: LoanCostDisclosurePanelProps) {
  const rows = buildDisclosureRows(disclosure);
  const isAuthoritative: DisclosureSource = reconciliation?.authoritativeTotal
    ? "authoritative"
    : disclosure.source;

  return (
    <Card data-testid="loan-cost-disclosure">
      <CardHeader className={compact ? "pb-4" : undefined}>
        <CardTitle className="flex items-center gap-2 text-lg">
          <ReceiptText className="h-5 w-5 text-indigo-500" />
          {title}
        </CardTitle>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">{description}</p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div
          className="rounded-lg border border-zinc-200 overflow-hidden dark:border-zinc-800"
          role="table"
          aria-label="Loan cost breakdown"
        >
          <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {rows.map((row) => (
              <div
                key={row.label}
                role="row"
                className="flex items-baseline justify-between gap-4 px-4 py-2.5 text-sm"
              >
                <span className="text-zinc-500 dark:text-zinc-400">{row.label}</span>
                <span
                  className={
                    row.emphasis === "total"
                      ? "font-semibold text-indigo-600 dark:text-indigo-400"
                      : row.emphasis === "cost"
                        ? "font-medium text-amber-700 dark:text-amber-400"
                        : row.emphasis === "muted"
                          ? "text-zinc-600 dark:text-zinc-400"
                          : "font-medium text-zinc-900 dark:text-zinc-50"
                  }
                >
                  {row.value}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div
          data-testid="loan-cost-disclosure-summary"
          className="flex flex-wrap items-baseline justify-between gap-2 rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-3 dark:border-indigo-900/50 dark:bg-indigo-950/30"
        >
          <span className="text-sm font-semibold text-indigo-900 dark:text-indigo-200">
            Total repayment
          </span>
          <span className="text-lg font-bold text-indigo-700 dark:text-indigo-300">
            {formatDisclosureAmount(disclosure.totalRepayment, disclosure.asset)}
          </span>
        </div>

        <p
          data-testid="loan-cost-effective-apr"
          className="text-sm text-zinc-600 dark:text-zinc-400"
        >
          Nominal APR {formatBps(disclosure.annualRateBps)} — effective APR{" "}
          <strong className="font-semibold text-zinc-900 dark:text-zinc-100">
            {formatBps(disclosure.effectiveAprBps)}
          </strong>{" "}
          once fees are included.
        </p>

        <ul
          data-testid="loan-cost-disclosure-statements"
          className="space-y-1.5 text-xs text-zinc-600 dark:text-zinc-400"
        >
          {disclosure.statements.map((statement) => (
            <li key={statement} className="flex gap-2">
              <Info className="mt-0.5 h-3 w-3 shrink-0 text-zinc-400" aria-hidden="true" />
              <span>{statement}</span>
            </li>
          ))}
        </ul>

        {disclosure.inputRounded && (
          <p
            data-testid="loan-cost-rounding-notice"
            className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300"
          >
            The amount you entered had more decimal places than {disclosure.asset} supports. This
            disclosure uses {formatDisclosureAmount(disclosure.principal, disclosure.asset)}.
          </p>
        )}

        {reconciliation && reconciliation.status === "divergent" && (
          <div
            role="status"
            data-testid="loan-cost-reconciliation-warning"
            className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300"
          >
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{reconciliation.explanation}</span>
          </div>
        )}

        {reconciliation && reconciliation.status === "unavailable" && (
          <div
            role="status"
            data-testid="loan-cost-reconciliation-stale"
            className="flex items-start gap-2 rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400"
          >
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              {reconciliation.explanation} The on-chain schedule is the binding amount if the two
              ever differ.
            </span>
          </div>
        )}

        <p
          data-testid="loan-cost-source"
          className="flex items-center gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-500"
        >
          <ShieldCheck className="h-3 w-3" aria-hidden="true" />
          {isAuthoritative === "authoritative"
            ? "Totals confirmed against the lending pool schedule."
            : "Estimate — the lending pool schedule is confirmed when you sign."}
        </p>

        <p className="sr-only">{summarizeDisclosure(disclosure)}</p>
      </CardContent>
    </Card>
  );
}

interface LoanCostDisclosureErrorProps {
  error: LoanCostError;
  title?: string;
}

/**
 * Renders a typed disclosure failure. The panel never falls back to a partial
 * or silently zeroed breakdown — a borrower is either shown exact costs or
 * told that the costs could not be computed.
 */
export function LoanCostDisclosureError({
  error,
  title = "Cost of loan unavailable",
}: LoanCostDisclosureErrorProps) {
  return (
    <div
      role="alert"
      data-testid="loan-cost-disclosure-error"
      className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-300"
    >
      <p className="font-semibold">{title}</p>
      <p className="mt-1">{error.message}</p>
      <p className="mt-1 text-xs opacity-80">
        Nothing was submitted. Adjust the loan details and try again.
      </p>
    </div>
  );
}
