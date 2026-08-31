"use client";

import { Loader2 } from "lucide-react";

interface PendingIndicatorProps {
  /** Whether the mutation is currently in flight. */
  pending: boolean;
  /** Label shown while pending. Defaults to "Submitting…". */
  label?: string;
  className?: string;
}

/**
 * Inline "Submitting…" indicator for optimistic mutations.
 *
 * Pair it with an optimistic cache update: the list shows the new row
 * immediately while this indicator communicates that the write is still
 * being confirmed by the server.
 */
export function PendingIndicator({
  pending,
  label = "Submitting…",
  className,
}: PendingIndicatorProps) {
  if (!pending) return null;

  return (
    <span
      role="status"
      aria-live="polite"
      className={
        "inline-flex items-center gap-1.5 text-xs font-medium text-zinc-500 dark:text-zinc-400" +
        (className ? ` ${className}` : "")
      }
    >
      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
      {label}
    </span>
  );
}
