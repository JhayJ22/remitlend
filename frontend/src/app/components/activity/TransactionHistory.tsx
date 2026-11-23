"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { Clock, ExternalLink, RotateCcw } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useMyTransactions, type MyTransaction } from "../../hooks/useApi";
import { useSSE } from "../../hooks/useSSE";
import { useWindowedList } from "../../hooks/useWindowedList";
import { useTransactionPreview } from "../../hooks/useTransactionPreview";
import { TransactionPreviewModal } from "../transaction/TransactionPreviewModal";
import { EmptyState } from "../ui/EmptyState";
import { StatusIndicator } from "../ui/StatusIndicator";
import { STELLAR_NETWORK_LABEL } from "../../utils/stellarNetwork";

const ROW_HEIGHT = 72;
const POLL_INTERVAL_MS = 10_000;
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export type TxStatus = "confirmed" | "pending" | "failed";

/** Normalise backend submission statuses to confirmed | pending | failed. */
export function normalizeTxStatus(status: string): TxStatus {
  const s = status.toLowerCase();
  if (["confirmed", "success", "successful", "completed"].includes(s)) return "confirmed";
  if (["failed", "error", "rejected", "expired"].includes(s)) return "failed";
  return "pending";
}

const TYPE_LABELS: Record<string, string> = {
  loan_request: "Loan request",
  repayment: "Repayment",
  deposit: "Deposit",
  withdraw: "Withdrawal",
  withdrawal: "Withdrawal",
  remittance: "Remittance",
};

export function txTypeLabel(type: string): string {
  return TYPE_LABELS[type.toLowerCase()] ?? type.replace(/_/g, " ");
}

function retryTarget(type: string): string {
  const t = type.toLowerCase();
  if (t.includes("remit")) return "/send-remittance";
  if (t.includes("deposit") || t.includes("withdraw")) return "/lender";
  return "/loans";
}

function explorerUrl(txHash: string): string {
  const net = STELLAR_NETWORK_LABEL.toLowerCase().includes("test") ? "testnet" : "public";
  return `https://stellar.expert/explorer/${net}/tx/${txHash}`;
}

function toTone(status: TxStatus) {
  return status === "confirmed" ? "success" : status === "failed" ? "danger" : "warning";
}

/** On-chain transaction history with live status tracking and failed-tx retry. */
export function TransactionHistory() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const txPreview = useTransactionPreview();
  const { data, isLoading, isError, refetch } = useMyTransactions({ limit: 100 });
  const items: MyTransaction[] = data?.items ?? [];
  const hasPending = items.some((t) => normalizeTxStatus(t.status) === "pending");

  const refresh = useCallback(() => {
    void refetch();
    void queryClient.invalidateQueries({ queryKey: ["transactions"] });
  }, [refetch, queryClient]);

  // Live updates: SSE when available, falling back to a 10 s poll while any tx is pending.
  useSSE({
    url: hasPending ? `${API_URL}/api/events/stream` : null,
    onMessage: refresh,
    onFallbackPoll: refresh,
    pollingInterval: POLL_INTERVAL_MS,
  });

  const { startIndex, endIndex, totalHeight, offsetY, containerRef } = useWindowedList({
    itemCount: items.length,
    itemHeight: ROW_HEIGHT,
    overscan: 20,
  });

  function handleRetry(tx: MyTransaction) {
    txPreview.show(
      {
        operations: [
          {
            type: txTypeLabel(tx.transactionType),
            description: `Retry failed ${txTypeLabel(tx.transactionType).toLowerCase()} (${tx.txHash.slice(0, 8)}…)`,
          },
        ],
        balanceChanges: [],
        network: STELLAR_NETWORK_LABEL,
      },
      async () => {
        router.push(retryTarget(tx.transactionType));
      },
    );
  }

  return (
    <section aria-label="On-chain transactions" className="space-y-3">
      <h2 className="text-xl font-bold text-zinc-900 dark:text-zinc-50">On-chain transactions</h2>

      <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        {isLoading ? (
          <div className="space-y-3 p-6" data-testid="tx-loading" aria-busy="true">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-14 animate-pulse rounded bg-zinc-100 dark:bg-zinc-900" />
            ))}
          </div>
        ) : isError ? (
          <p role="alert" className="p-6 text-sm text-red-600">
            Could not load transactions.
          </p>
        ) : items.length === 0 ? (
          <div className="p-6">
            <EmptyState
              icon={Clock}
              title="No transactions yet"
              description="Your on-chain transactions will appear here."
            />
          </div>
        ) : (
          <div
            ref={containerRef}
            className="max-h-[60vh] overflow-y-auto"
            role="list"
            aria-label={`${items.length} transactions`}
          >
            <div style={{ height: totalHeight, position: "relative" }}>
              <div style={{ transform: `translateY(${offsetY}px)` }}>
                {items.slice(startIndex, endIndex + 1).map((tx) => {
                  const status = normalizeTxStatus(tx.status);
                  return (
                    <div
                      key={tx.id}
                      role="listitem"
                      data-testid="tx-row"
                      className="flex h-[72px] items-center justify-between gap-3 border-b border-zinc-200 px-4 dark:border-zinc-800"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-semibold capitalize text-zinc-900 dark:text-zinc-50">
                          {txTypeLabel(tx.transactionType)}
                        </p>
                        <p className="text-xs text-zinc-500 dark:text-zinc-400">
                          {new Date(tx.submittedAt).toLocaleString("en-US")}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-3">
                        <StatusIndicator label={status} tone={toTone(status)} />
                        {status === "failed" && (
                          <button
                            type="button"
                            onClick={() => handleRetry(tx)}
                            className="inline-flex items-center gap-1 rounded-md border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-700"
                          >
                            <RotateCcw className="h-3 w-3" aria-hidden="true" />
                            Retry
                          </button>
                        )}
                        <a
                          href={explorerUrl(tx.txHash)}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={`View transaction ${tx.txHash} on Stellar Explorer`}
                          className="text-indigo-600 dark:text-indigo-400"
                        >
                          <ExternalLink className="h-4 w-4" />
                        </a>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>

      <TransactionPreviewModal
        isOpen={txPreview.isOpen}
        onClose={txPreview.close}
        onConfirm={txPreview.confirm}
        data={
          txPreview.data || { operations: [], balanceChanges: [], network: STELLAR_NETWORK_LABEL }
        }
        isLoading={txPreview.isLoading}
      />
    </section>
  );
}
