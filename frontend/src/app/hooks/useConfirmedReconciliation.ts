/**
 * hooks/useConfirmedReconciliation.ts
 *
 * Authoritative reconciliation after optimistic settlement (#350).
 *
 * Problem
 * ───────
 * Optimistic updates (onMutate in TanStack Query) apply an *estimated*
 * state change immediately to give instant feedback. Once the transaction
 * is confirmed on-chain the backend has the authoritative numbers
 * (accrued interest, pool utilisation rate, updated balances, etc.).
 * Until the cache is invalidated and the refetch completes the UI can show
 * stale optimistic values that diverge from reality.
 *
 * Solution
 * ────────
 * After a transaction reaches the "confirmed" stage (txHash known +
 * on-chain ledger closed) this hook:
 *
 *  1. Immediately invalidates the affected query keys so TanStack Query
 *     schedules a background refetch.
 *  2. Awaits the refetch to resolve so the calling component can react to
 *     the authoritative data (e.g. show a final balance, close a dialog).
 *  3. Returns `{ reconcile }` — a stable callback the consumer calls with
 *     the set of keys to refresh and an optional "confirmed" txHash for
 *     logging.
 *
 * Design decisions
 * ────────────────
 * - Reconciliation is separate from the mutation's own `onSettled` because
 *   `onSettled` fires immediately after the server responds. Actual on-chain
 *   confirmation can lag by several ledgers. Callers call `reconcile()` only
 *   after they have verified the txHash is confirmed (via polling or SSE).
 * - No financial arithmetic happens here. Numbers always come from the
 *   backend refetch — the authoritative source.
 * - The function is safe to call multiple times; duplicate key invalidation
 *   is idempotent.
 *
 * Usage
 * ─────
 * ```tsx
 * const { reconcile } = useConfirmedReconciliation();
 *
 * // After you have confirmed the tx is on-chain:
 * await reconcile({
 *   keys: [queryKeys.loans.detail(String(loanId)), queryKeys.pool.stats()],
 *   txHash: "abc123",
 * });
 * ```
 *
 * Threat-model notes
 * ──────────────────
 * - txHash is logged for auditability only; it is never used to gate UI
 *   logic. Only the backend-refetched state drives what the user sees.
 * - Reconciliation does NOT suppress rollback: if a prior mutation already
 *   rolled back the optimistic state on error, `reconcile` simply confirms
 *   the correct (already-rolled-back) cache data with the latest server value.
 */

import { useCallback } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";

export interface ReconcileOptions {
  /** Query keys whose cached data should be refreshed from the server. */
  keys: QueryKey[];
  /**
   * The confirmed on-chain transaction hash. Used for logging/observability
   * only — does not affect the reconciliation logic.
   */
  txHash?: string;
}

export interface UseConfirmedReconciliationResult {
  /**
   * Invalidates the given query keys and waits for all refetches to complete.
   * Resolves once TanStack Query has received authoritative data from the
   * server for every supplied key.
   */
  reconcile: (options: ReconcileOptions) => Promise<void>;
}

export function useConfirmedReconciliation(): UseConfirmedReconciliationResult {
  const queryClient = useQueryClient();

  const reconcile = useCallback(
    async ({ keys, txHash }: ReconcileOptions): Promise<void> => {
      if (keys.length === 0) return;

      if (process.env.NODE_ENV !== "production") {
        console.info("[reconcile] Starting authoritative reconciliation", {
          keys,
          txHash: txHash ?? "(none)",
        });
      }

      // Invalidate all supplied keys concurrently, then await all refetches.
      await Promise.all(
        keys.map((key) => queryClient.invalidateQueries({ queryKey: key, refetchType: "active" })),
      );

      if (process.env.NODE_ENV !== "production") {
        console.info("[reconcile] Reconciliation complete", {
          keys,
          txHash: txHash ?? "(none)",
        });
      }
    },
    [queryClient],
  );

  return { reconcile };
}
