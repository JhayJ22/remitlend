"use client";

import { Printer } from "lucide-react";
import { useCallback } from "react";
import { cn } from "@/app/utils/cn";

interface PrintButtonProps {
  /** Visible button label. */
  label?: string;
  /** Temporarily overrides `document.title` so the print/PDF filename is meaningful. */
  documentTitle?: string;
  className?: string;
}

/**
 * Triggers the browser print dialog for the current page. The print output is
 * shaped by the `@media print` rules in `globals.css` (app chrome hidden, cards
 * flattened, charts kept whole). The button hides itself when printing.
 */
export function PrintButton({ label = "Print", documentTitle, className }: PrintButtonProps) {
  const handlePrint = useCallback(() => {
    const previousTitle = document.title;

    if (documentTitle) {
      document.title = documentTitle;
    }

    const restore = () => {
      document.title = previousTitle;
      window.removeEventListener("afterprint", restore);
    };
    window.addEventListener("afterprint", restore);

    window.print();
  }, [documentTitle]);

  return (
    <button
      type="button"
      onClick={handlePrint}
      data-print-hidden
      className={cn(
        "inline-flex items-center gap-2 rounded-full border border-zinc-300 px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900",
        className,
      )}
    >
      <Printer className="h-4 w-4" aria-hidden="true" />
      {label}
    </button>
  );
}
