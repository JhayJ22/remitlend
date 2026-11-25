"use client";

import * as React from "react";
import { X } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useModalFocusTrap } from "../../hooks/useModalFocusTrap";
import { useSwipe } from "../../hooks/useSwipe";
import { cn } from "@/app/utils/cn";

export interface BottomSheetProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  /** Accessible name when no visible title is provided. */
  ariaLabel?: string;
  children: React.ReactNode;
  className?: string;
  /** Minimum downward swipe (px) on the handle/header that dismisses the sheet. Default 64. */
  swipeThreshold?: number;
}

/**
 * Mobile bottom-sheet drawer (UIUX Mobile First spec).
 *
 * - Slides up from the bottom edge; content scrolls inside, capped at 90dvh.
 * - Swipe down on the drag handle / header to dismiss (useSwipe). The gesture
 *   is scoped to the header so it never fights with content scrolling.
 * - Same accessibility contract as Modal: role="dialog", aria-modal, focus
 *   trap and Escape-to-dismiss via useModalFocusTrap, focus restored on close.
 *
 * Usually rendered for you by `Modal` on screens < 768px; use directly when a
 * sheet is wanted at every breakpoint.
 */
export function BottomSheet({
  isOpen,
  onClose,
  title,
  ariaLabel,
  children,
  className,
  swipeThreshold = 64,
}: BottomSheetProps) {
  const sheetRef = React.useRef<HTMLDivElement>(null);
  const closeButtonRef = React.useRef<HTMLButtonElement>(null);
  const titleId = React.useId();

  useModalFocusTrap({
    isOpen,
    onClose,
    containerRef: sheetRef,
    initialFocusRef: closeButtonRef,
  });

  const swipe = useSwipe({ onSwipeDown: onClose, threshold: swipeThreshold });

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm"
            data-testid="bottom-sheet-backdrop"
            onClick={onClose}
          />

          <motion.div
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", bounce: 0, duration: 0.3 }}
            ref={sheetRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={title ? titleId : undefined}
            aria-label={!title ? ariaLabel : undefined}
            tabIndex={-1}
            data-testid="bottom-sheet"
            className={cn(
              "relative flex max-h-[90dvh] w-full flex-col rounded-t-2xl bg-white shadow-2xl focus:outline-none dark:border-t dark:border-zinc-800 dark:bg-zinc-950",
              "pb-[env(safe-area-inset-bottom)]",
              className,
              // Sheets are always full-width; neutralise desktop max-w-* overrides.
              "max-w-none",
            )}
          >
            <div
              {...swipe}
              data-testid="bottom-sheet-handle"
              className="shrink-0 touch-none select-none border-b border-gray-100 px-5 pb-3 pt-2 dark:border-zinc-800"
            >
              <div
                aria-hidden="true"
                className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-gray-300 dark:bg-zinc-700"
              />
              <div className="flex items-center justify-between gap-3">
                {title ? (
                  <h3
                    id={titleId}
                    className="text-lg font-semibold text-gray-900 dark:text-zinc-100"
                  >
                    {title}
                  </h3>
                ) : (
                  <span />
                )}
                <button
                  ref={closeButtonRef}
                  type="button"
                  onClick={onClose}
                  aria-label="Close"
                  className="rounded-full p-2 text-gray-400 hover:bg-gray-100 dark:text-zinc-500 dark:hover:bg-zinc-900"
                >
                  <X size={20} />
                </button>
              </div>
            </div>
            <div className="overflow-y-auto overscroll-contain p-5">{children}</div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

export default BottomSheet;
