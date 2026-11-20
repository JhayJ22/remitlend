"use client";

import { useState, useCallback, type ReactNode } from "react";
import { Eye, EyeOff, Copy, CheckCheck } from "lucide-react";
import { cn } from "../../utils/cn";

/**
 * Reusable masked value component for sensitive financial data (#838).
 *
 * Renders a value that can be masked (hidden behind a fixed-width "••••••••"
 * placeholder) or revealed. The mask replaces the real value in:
 *
 * - The visible text content (no real value in the DOM)
 * - The accessible name (aria-label is "hidden" when masked, not the real value)
 * - The title attribute (same)
 * - Clipboard copy (copy is disabled when masked, copying nothing)
 *
 * When `globalMask` is true (reduced-data mode is on), the value starts masked.
 * The user can click the reveal toggle to temporarily unmask it. When
 * `globalMask` is false, the value is always shown in full.
 *
 * The component is purely presentational — it never modifies the authoritative
 * source of truth. The `value` prop is always the real value; only the
 * rendered output changes.
 *
 * @example
 * <MaskedValue value="$1,234.56" globalMask={reducedDataMode} ariaLabel="Account balance" />
 * <MaskedValue value="GA1234..." globalMask={reducedDataMode} ariaLabel="Wallet address" mono />
 */

export interface MaskedValueProps {
  /** The real value to display when revealed. */
  value: string;
  /** When true, the value starts masked (reduced-data mode is on). */
  globalMask: boolean;
  /** Accessible label for the value (e.g. "Account balance"). Used in aria-label. */
  ariaLabel: string;
  /** Render the value in monospace font (for addresses/hashes). */
  mono?: boolean;
  /** Additional CSS classes. */
  className?: string;
  /** Font size class (default: text-sm). */
  sizeClass?: string;
  /** Font weight class (default: font-semibold). */
  weightClass?: string;
  /** Color class (default: text-zinc-900 dark:text-zinc-50). */
  colorClass?: string;
  /** When true, don't show the reveal/conceal toggle button. */
  hideToggle?: boolean;
}

const MASK_DISPLAY = "••••••••";

export function MaskedValue({
  value,
  globalMask,
  ariaLabel,
  mono = false,
  className,
  sizeClass = "text-sm",
  weightClass = "font-semibold",
  colorClass = "text-zinc-900 dark:text-zinc-50",
  hideToggle = false,
}: MaskedValueProps) {
  const [locallyRevealed, setLocallyRevealed] = useState(false);

  // When globalMask is false, always show the real value.
  // When globalMask is true, show the mask unless the user has locally revealed.
  const isMasked = globalMask && !locallyRevealed;

  const displayValue = isMasked ? MASK_DISPLAY : value;
  const accessibleName = isMasked ? `${ariaLabel} hidden` : ariaLabel;

  const handleToggle = useCallback(() => {
    setLocallyRevealed((prev) => !prev);
  }, []);

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <span
        className={cn(sizeClass, weightClass, colorClass, mono && "font-mono break-all")}
        aria-label={accessibleName}
        // When masked, the real value must not be in the title attribute either.
        title={isMasked ? `${ariaLabel} hidden` : undefined}
        // Prevent text selection when masked so screenshot tools and drag-select
        // cannot capture the real value. This also prevents accidental copy via
        // keyboard shortcuts (Ctrl+A, Ctrl+C) when the value is masked.
        style={isMasked ? { userSelect: "none" } : undefined}
      >
        {displayValue}
      </span>

      {/* Reveal/conceal toggle — only shown when globalMask is on and toggle is not hidden */}
      {globalMask && !hideToggle && (
        <button
          type="button"
          onClick={handleToggle}
          className="p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          aria-label={locallyRevealed ? `Hide ${ariaLabel}` : `Reveal ${ariaLabel}`}
          aria-pressed={locallyRevealed}
        >
          {locallyRevealed ? (
            <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <Eye className="h-3.5 w-3.5" aria-hidden="true" />
          )}
        </button>
      )}

      {/* Copy button — disabled when masked so the real value cannot be copied */}
      {!hideToggle && (
        <button
          type="button"
          disabled={isMasked}
          onClick={() => {
            if (isMasked) return;
            void navigator.clipboard?.writeText(value);
          }}
          className="p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-30"
          aria-label={isMasked ? `Copy ${ariaLabel} disabled (hidden)` : `Copy ${ariaLabel}`}
          // Copy is disabled when masked so no real value reaches the clipboard.
          tabIndex={isMasked ? -1 : 0}
        >
          <Copy className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

/**
 * MaskedValueText — a lighter variant for inline text without the toggle/copy
 * buttons. Used in compact stat cards where space is limited.
 *
 * Renders the mask when `globalMask` is true. The real value is NOT rendered
 * in the DOM when masked.
 */
export function MaskedValueText({
  value,
  globalMask,
  ariaLabel,
  className,
  mono = false,
}: {
  value: string;
  globalMask: boolean;
  ariaLabel: string;
  className?: string;
  mono?: boolean;
}) {
  const isMasked = globalMask;
  const displayValue = isMasked ? MASK_DISPLAY : value;
  const accessibleName = isMasked ? `${ariaLabel} hidden` : ariaLabel;

  return (
    <span
      className={cn(mono && "font-mono break-all", className)}
      aria-label={accessibleName}
      title={isMasked ? `${ariaLabel} hidden` : undefined}
      style={isMasked ? { userSelect: "none" } : undefined}
    >
      {displayValue}
    </span>
  );
}
