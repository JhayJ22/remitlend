"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useFloating, type Placement } from "./useFloating";

interface TooltipProps {
  /** The tooltip text / content. */
  content: ReactNode;
  /** The element the tooltip describes. Must be focusable for keyboard users. */
  children: ReactNode;
  placement?: Placement;
  offset?: number;
  /** Hover open delay in ms (focus opens immediately). */
  delay?: number;
  /** Disables the tooltip without unmounting the trigger. */
  disabled?: boolean;
}

/**
 * Accessible tooltip built on the shared positioning engine.
 *
 * - Opens on hover (after `delay`) and on keyboard focus.
 * - Closes on blur, mouse leave and `Escape`.
 * - Never clips off-screen: the engine flips and shifts to stay in the viewport.
 * - Linked to the trigger via `aria-describedby` and `role="tooltip"`.
 */
export function Tooltip({
  content,
  children,
  placement = "top",
  offset = 8,
  delay = 150,
  disabled = false,
}: TooltipProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { referenceRef, floatingRef, coords } = useFloating({ placement, offset, open });

  const clearTimer = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };

  useEffect(() => {
    setMounted(true);
    return clearTimer;
  }, []);

  const show = () => {
    if (disabled) return;
    clearTimer();
    timer.current = setTimeout(() => setOpen(true), delay);
  };

  const hide = () => {
    clearTimer();
    setOpen(false);
  };

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    <>
      <span
        ref={(node) => {
          referenceRef.current = node;
        }}
        className="inline-flex"
        style={{ maxWidth: "100%" }}
        aria-describedby={open ? id : undefined}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocusCapture={show}
        onBlurCapture={hide}
      >
        {children}
      </span>

      {mounted &&
        open &&
        !disabled &&
        createPortal(
          <div
            ref={(node) => {
              floatingRef.current = node;
            }}
            role="tooltip"
            id={id}
            style={{
              position: "fixed",
              left: coords.x,
              top: coords.y,
              zIndex: 70,
              pointerEvents: "none",
            }}
            className="max-w-xs rounded-lg bg-zinc-900 px-2.5 py-1.5 text-xs font-medium leading-snug text-white shadow-lg dark:bg-zinc-100 dark:text-zinc-900"
          >
            {content}
          </div>,
          document.body,
        )}
    </>
  );
}
