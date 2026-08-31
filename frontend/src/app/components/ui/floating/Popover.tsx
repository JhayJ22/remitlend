"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useFloating, type Placement } from "./useFloating";

interface PopoverProps {
  /** Rendered inside the trigger button. */
  trigger: ReactNode;
  /** Popover panel contents. */
  children: ReactNode;
  placement?: Placement;
  offset?: number;
  /** Accessible name for the popover dialog. */
  ariaLabel?: string;
  /** Overrides the default panel styling. */
  className?: string;
  /** Overrides the default trigger styling. */
  triggerClassName?: string;
}

/**
 * Click-triggered popover built on the shared positioning engine.
 *
 * - Toggles on trigger click; closes on `Escape`, outside click and re-click.
 * - Moves focus into the panel on open and back to the trigger on `Escape`.
 * - `role="dialog"` panel wired to the trigger via `aria-controls` / `aria-expanded`.
 * - Never clips off-screen (engine flips + shifts within the viewport).
 */
export function Popover({
  trigger,
  children,
  placement = "bottom",
  offset = 10,
  ariaLabel,
  className,
  triggerClassName,
}: PopoverProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const { referenceRef, floatingRef, coords } = useFloating({ placement, offset, open });

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };

    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!floatingRef.current?.contains(target) && !triggerRef.current?.contains(target)) {
        setOpen(false);
      }
    };

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [open, floatingRef]);

  useEffect(() => {
    if (!open) return;
    const panel = floatingRef.current;
    if (!panel) return;
    const focusable = panel.querySelector<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    (focusable ?? panel).focus();
  }, [open, floatingRef]);

  return (
    <>
      <button
        type="button"
        ref={(node) => {
          triggerRef.current = node;
          referenceRef.current = node;
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((value) => !value)}
        className={triggerClassName ?? "inline-flex items-center"}
      >
        {trigger}
      </button>

      {mounted &&
        open &&
        createPortal(
          <div
            ref={(node) => {
              floatingRef.current = node;
            }}
            id={id}
            role="dialog"
            aria-label={ariaLabel}
            tabIndex={-1}
            style={{ position: "fixed", left: coords.x, top: coords.y, zIndex: 70 }}
            className={
              className ??
              "w-64 rounded-xl border border-zinc-200 bg-white p-4 text-sm text-zinc-700 shadow-xl outline-none dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200"
            }
          >
            {children}
          </div>,
          document.body,
        )}
    </>
  );
}
