"use client";

import { useCallback, useState } from "react";
import { AlertTriangle, Check, Copy, LifeBuoy, RotateCw, XCircle } from "lucide-react";
import { Button } from "../ui/Button";
import type {
  RecoveryActionId,
  TransactionFailureState,
  TransactionRecoveryPlan,
} from "../../utils/transactionRecovery";

interface TransactionRecoveryPanelProps {
  plan: TransactionRecoveryPlan;
  /**
   * Invoked when the borrower picks a recovery action. The host owns the side
   * effects (re-polling, re-signing, reloading) so this component stays pure
   * and testable.
   */
  onAction?: (actionId: RecoveryActionId) => void;
  /** Disables action buttons while an action is in flight. */
  busy?: boolean;
}

const STATE_STYLES: Record<
  TransactionFailureState,
  { border: string; icon: React.ReactNode; badge: string }
> = {
  rejected: {
    border: "border-amber-200 bg-amber-50 dark:border-amber-900/50 dark:bg-amber-950/20",
    icon: <XCircle className="h-5 w-5 text-amber-600" aria-hidden="true" />,
    badge: "Declined",
  },
  expired: {
    border: "border-amber-200 bg-amber-50 dark:border-amber-900/50 dark:bg-amber-950/20",
    icon: <AlertTriangle className="h-5 w-5 text-amber-600" aria-hidden="true" />,
    badge: "Expired",
  },
  failed: {
    border: "border-red-200 bg-red-50 dark:border-red-900/50 dark:bg-red-950/20",
    icon: <AlertTriangle className="h-5 w-5 text-red-600" aria-hidden="true" />,
    badge: "Not completed",
  },
  unknown: {
    border: "border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900",
    icon: <AlertTriangle className="h-5 w-5 text-zinc-600" aria-hidden="true" />,
    badge: "Unknown",
  },
};

function explorerUrl(txHash: string | null | undefined, network: string): string | null {
  if (!txHash) return null;
  const base =
    network === "mainnet"
      ? "https://stellar.expert/explorer/mainnet/tx"
      : "https://stellar.expert/explorer/testnet/tx";
  return `${base}/${txHash}`;
}

/**
 * Presents a recovery plan for a rejected, expired or otherwise stalled
 * transaction: what happened, whether submitting again is safe, the ordered
 * steps, and one button per safe next action.
 */
export function TransactionRecoveryPanel({
  plan,
  onAction,
  busy = false,
  txHash = null,
  network = "testnet",
}: TransactionRecoveryPanelProps & { txHash?: string | null; network?: string }) {
  const [copied, setCopied] = useState(false);
  const style = STATE_STYLES[plan.state];
  const explorer = explorerUrl(txHash, network);

  const handleCopy = useCallback(async () => {
    if (!txHash) return;
    try {
      await navigator.clipboard?.writeText(txHash);
      setCopied(true);
    } catch {
      // Clipboard access can be denied; the hash stays visible on screen.
      setCopied(false);
    }
    onAction?.("copy_tx_hash");
  }, [onAction, txHash]);

  return (
    <section
      role="alert"
      aria-live="polite"
      data-testid="transaction-recovery-panel"
      data-state={plan.state}
      className={`rounded-xl border p-4 ${style.border}`}
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5">{style.icon}</div>
        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              {style.badge}
            </p>
            <h3
              className="text-sm font-semibold text-zinc-900 dark:text-zinc-100"
              data-testid="transaction-recovery-headline"
            >
              {plan.headline}
            </h3>
            <p className="text-sm text-zinc-700 dark:text-zinc-300">{plan.summary}</p>
          </div>

          {plan.resubmitWarning && (
            <p
              data-testid="transaction-recovery-duplicate-warning"
              className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs font-medium text-red-800 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300"
            >
              {plan.resubmitWarning}
            </p>
          )}

          <ol
            data-testid="transaction-recovery-steps"
            className="list-decimal space-y-1 pl-5 text-xs text-zinc-700 dark:text-zinc-300"
          >
            {plan.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>

          {txHash && (
            <p className="break-all font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
              Transaction ID: {txHash}
            </p>
          )}

          <div className="flex flex-wrap gap-2 pt-1">
            {plan.actions.map((action) => {
              if (action.id === "check_explorer" && !explorer) return null;
              if (action.id === "copy_tx_hash" && !txHash) return null;

              if (action.id === "check_explorer" && explorer) {
                return (
                  <a
                    key={action.id}
                    href={explorer}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={action.description}
                    data-testid={`transaction-recovery-action-${action.id}`}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 transition hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
                  >
                    {action.label}
                  </a>
                );
              }

              return (
                <Button
                  key={action.id}
                  variant={action.variant === "primary" ? "primary" : "outline"}
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    if (action.id === "copy_tx_hash") {
                      void handleCopy();
                      return;
                    }
                    onAction?.(action.id);
                  }}
                  title={action.description}
                  data-testid={`transaction-recovery-action-${action.id}`}
                  leftIcon={
                    action.id === "copy_tx_hash" ? (
                      copied ? (
                        <Check className="h-3.5 w-3.5" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )
                    ) : action.id === "contact_support" ? (
                      <LifeBuoy className="h-3.5 w-3.5" />
                    ) : (
                      <RotateCw className="h-3.5 w-3.5" />
                    )
                  }
                >
                  {action.id === "copy_tx_hash" && copied ? "Copied" : action.label}
                </Button>
              );
            })}
          </div>

          {plan.actions.some((a) => a.requiresSignature) && !plan.safeToResubmit && (
            <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
              Actions that start a new transaction always ask your wallet to sign again.
            </p>
          )}

          <p className="text-[11px] text-zinc-500 dark:text-zinc-500">
            Support code:{" "}
            <span data-testid="transaction-recovery-support-code">{plan.supportCode}</span>
          </p>
        </div>
      </div>
    </section>
  );
}
