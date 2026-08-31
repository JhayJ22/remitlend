"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type Side = "top" | "bottom" | "left" | "right";
export type Align = "start" | "center" | "end";
export type Placement = Side | `${Side}-${Align}`;

export interface FloatingCoords {
  x: number;
  y: number;
  /** The placement actually used after collision handling (may differ from the request). */
  placement: Placement;
  /** Offset of the arrow along the floating element's edge, in pixels. */
  arrowX: number;
  arrowY: number;
}

interface UseFloatingOptions {
  placement?: Placement;
  /** Gap between the reference and floating element, in pixels. */
  offset?: number;
  /** Minimum distance to keep from the viewport edge, in pixels. */
  padding?: number;
  /** Only tracks/positions while `true`. */
  open: boolean;
}

const OPPOSITE: Record<Side, Side> = {
  top: "bottom",
  bottom: "top",
  left: "right",
  right: "left",
};

function splitPlacement(placement: Placement): [Side, Align] {
  const [side, align = "center"] = placement.split("-") as [Side, Align];
  return [side, align];
}

/**
 * Frame-agnostic positioning engine for tooltips and popovers.
 *
 * Handles the three things hand-rolled tooltips usually get wrong:
 *  - flips to the opposite side when the preferred side overflows the viewport;
 *  - shifts along the cross axis so the element is never clipped at an edge;
 *  - re-computes on scroll, resize and size changes (ResizeObserver).
 */
function computePosition(
  reference: DOMRect,
  floating: { width: number; height: number },
  placement: Placement,
  offset: number,
  padding: number,
): FloatingCoords {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const [preferredSide, align] = splitPlacement(placement);

  const positionFor = (side: Side): { x: number; y: number } => {
    let x = 0;
    let y = 0;

    if (side === "top" || side === "bottom") {
      y = side === "top" ? reference.top - floating.height - offset : reference.bottom + offset;
      if (align === "start") x = reference.left;
      else if (align === "end") x = reference.right - floating.width;
      else x = reference.left + reference.width / 2 - floating.width / 2;
    } else {
      x = side === "left" ? reference.left - floating.width - offset : reference.right + offset;
      if (align === "start") y = reference.top;
      else if (align === "end") y = reference.bottom - floating.height;
      else y = reference.top + reference.height / 2 - floating.height / 2;
    }

    return { x, y };
  };

  const overflowFor = (x: number, y: number) => ({
    top: padding - y,
    bottom: y + floating.height - (vh - padding),
    left: padding - x,
    right: x + floating.width - (vw - padding),
  });

  let side = preferredSide;
  let { x, y } = positionFor(side);

  // Flip to the opposite side if the preferred side overflows and the flip fits better.
  const overflow = overflowFor(x, y);
  if (overflow[side] > 0) {
    const flipped = positionFor(OPPOSITE[side]);
    if (overflowFor(flipped.x, flipped.y)[OPPOSITE[side]] < overflow[side]) {
      side = OPPOSITE[side];
      x = flipped.x;
      y = flipped.y;
    }
  }

  // Shift along the cross axis so the element stays fully on screen.
  if (side === "top" || side === "bottom") {
    x = Math.min(Math.max(x, padding), Math.max(padding, vw - padding - floating.width));
  } else {
    y = Math.min(Math.max(y, padding), Math.max(padding, vh - padding - floating.height));
  }

  // Point the arrow at the reference centre, clamped to the floating edge.
  const referenceCenterX = reference.left + reference.width / 2;
  const referenceCenterY = reference.top + reference.height / 2;
  const arrowX = Math.min(Math.max(referenceCenterX - x, 8), Math.max(8, floating.width - 8));
  const arrowY = Math.min(Math.max(referenceCenterY - y, 8), Math.max(8, floating.height - 8));

  const resolvedPlacement = (align === "center" ? side : `${side}-${align}`) as Placement;

  return { x, y, placement: resolvedPlacement, arrowX, arrowY };
}

export function useFloating({
  placement = "top",
  offset = 8,
  padding = 8,
  open,
}: UseFloatingOptions) {
  const referenceRef = useRef<HTMLElement | null>(null);
  const floatingRef = useRef<HTMLElement | null>(null);
  const [coords, setCoords] = useState<FloatingCoords>({
    x: 0,
    y: 0,
    placement,
    arrowX: 0,
    arrowY: 0,
  });

  const update = useCallback(() => {
    const reference = referenceRef.current;
    const floating = floatingRef.current;
    if (!reference || !floating) return;

    setCoords(
      computePosition(
        reference.getBoundingClientRect(),
        { width: floating.offsetWidth, height: floating.offsetHeight },
        placement,
        offset,
        padding,
      ),
    );
  }, [placement, offset, padding]);

  useEffect(() => {
    if (!open) return;

    update();

    const handle = () => update();
    window.addEventListener("scroll", handle, true);
    window.addEventListener("resize", handle);

    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(handle);
      if (floatingRef.current) observer.observe(floatingRef.current);
      if (referenceRef.current) observer.observe(referenceRef.current);
    }

    return () => {
      window.removeEventListener("scroll", handle, true);
      window.removeEventListener("resize", handle);
      observer?.disconnect();
    };
  }, [open, update]);

  return { referenceRef, floatingRef, coords, update };
}
