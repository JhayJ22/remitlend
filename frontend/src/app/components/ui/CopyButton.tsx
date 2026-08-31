"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, CheckCheck } from "lucide-react";
import { cn } from "@/app/utils/cn";

interface CopyButtonProps {
  /** The string to place on the clipboard. */
  value: string;
  /** Accessible description of what is being copied, e.g. "wallet address". */
  label?: string;
  /** Render the word "Copied!" next to the icon while the feedback is showing. */
  showLabel?: boolean;
  className?: string;
}

/** How long the "Copied!" confirmation stays visible after a successful copy. */
export const COPY_FEEDBACK_RESET_MS = 2000;

/**
 * Copy the given text to the clipboard.
 *
 * Uses the async Clipboard API where available (all modern browsers, requires a
 * secure context) and falls back to a hidden `<textarea>` + `document.execCommand`
 * for older mobile browsers and non-HTTPS origins.
 */
export async function copyToClipboard(value: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // fall through to the legacy path
    }
  }

  if (typeof document === "undefined") return false;

  try {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "-9999px";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

export function CopyButton({
  value,
  label = "to clipboard",
  showLabel = false,
  className,
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timeoutRef.current), []);

  const handleCopy = useCallback(async () => {
    const ok = await copyToClipboard(value);
    if (!ok) return;
    setCopied(true);
    clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setCopied(false), COPY_FEEDBACK_RESET_MS);
  }, [value]);

  const title = copied ? "Copied!" : `Copy ${label}`;

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={cn(
        "inline-flex min-h-[32px] items-center gap-1.5 rounded-md p-1.5 text-zinc-400 transition-colors",
        "hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500",
        className,
      )}
      title={title}
      aria-label={copied ? `Copied ${label}` : `Copy ${label}`}
      aria-live="polite"
    >
      {copied ? (
        <CheckCheck className="h-4 w-4 text-green-500" aria-hidden="true" />
      ) : (
        <Copy className="h-4 w-4" aria-hidden="true" />
      )}
      {showLabel && <span className="text-xs font-medium">{copied ? "Copied!" : "Copy"}</span>}
    </button>
  );
}
