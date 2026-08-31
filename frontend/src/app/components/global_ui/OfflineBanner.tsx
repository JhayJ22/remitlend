"use client";

import { useEffect } from "react";
import { CloudOff, RefreshCw, WifiOff } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useOfflineQueue } from "../../hooks/useOfflineQueue";

/**
 * Connectivity + background-sync indicator.
 *
 * - Shows an offline notice while `navigator.onLine` is false.
 * - Shows a "syncing N queued action(s)" notice while the offline request
 *   queue is being replayed after reconnecting.
 */
export function OfflineBanner() {
  const queryClient = useQueryClient();
  const { isOnline, pendingCount, status, sync } = useOfflineQueue();

  useEffect(() => {
    if (isOnline) {
      queryClient.refetchQueries({ type: "active" });
    }
  }, [isOnline, queryClient]);

  const showSyncing = isOnline && (status === "syncing" || (pendingCount > 0 && status !== "idle"));

  if (isOnline && !showSyncing) return null;

  if (!isOnline) {
    return (
      <div
        className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200"
        role="status"
        aria-live="polite"
      >
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <WifiOff className="h-4 w-4" aria-hidden="true" />
            You appear to be offline. Showing cached data
            {pendingCount > 0
              ? ` · ${pendingCount} action${pendingCount === 1 ? "" : "s"} queued`
              : ""}
            .
          </div>
          <button
            type="button"
            onClick={() => queryClient.refetchQueries({ type: "active" })}
            className="rounded-full bg-amber-900 px-3 py-1 text-xs font-semibold text-amber-50 transition hover:bg-amber-800 dark:bg-amber-200 dark:text-amber-950 dark:hover:bg-amber-100"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const isError = status === "error";

  return (
    <div
      className={
        isError
          ? "border-b border-rose-200 bg-rose-50 px-4 py-2 text-rose-900 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-200"
          : "border-b border-sky-200 bg-sky-50 px-4 py-2 text-sky-900 dark:border-sky-900/50 dark:bg-sky-950/30 dark:text-sky-200"
      }
      role="status"
      aria-live="polite"
    >
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          {isError ? (
            <CloudOff className="h-4 w-4" aria-hidden="true" />
          ) : (
            <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />
          )}
          {isError
            ? `${pendingCount} queued action${pendingCount === 1 ? "" : "s"} failed to sync.`
            : `Back online — syncing ${pendingCount} queued action${pendingCount === 1 ? "" : "s"}…`}
        </div>
        {isError ? (
          <button
            type="button"
            onClick={() => void sync()}
            className="rounded-full bg-rose-900 px-3 py-1 text-xs font-semibold text-rose-50 transition hover:bg-rose-800 dark:bg-rose-200 dark:text-rose-950 dark:hover:bg-rose-100"
          >
            Retry sync
          </button>
        ) : null}
      </div>
    </div>
  );
}
