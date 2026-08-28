"use client";

import { useRef, type TouchEvent } from "react";

export interface SwipeHandlers {
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
  onSwipeUp?: () => void;
  onSwipeDown?: () => void;
  /** Minimum travel in px before a gesture counts as a swipe. Default 48. */
  threshold?: number;
}

interface SwipeBindings {
  onTouchStart: (e: TouchEvent) => void;
  onTouchEnd: (e: TouchEvent) => void;
}

/**
 * Lightweight touch-swipe detector for carousels, modals and sheets.
 *
 * Spread the returned object onto the element you want to make swipeable:
 *
 * ```tsx
 * const swipe = useSwipe({ onSwipeLeft: next, onSwipeRight: prev });
 * <div {...swipe}>…</div>
 * ```
 *
 * Pointer/mouse dragging is intentionally not handled — this is for touch
 * devices, where swipe is the expected interaction. Keep keyboard/button
 * controls for everyone else.
 */
export function useSwipe({
  onSwipeLeft,
  onSwipeRight,
  onSwipeUp,
  onSwipeDown,
  threshold = 48,
}: SwipeHandlers): SwipeBindings {
  const start = useRef<{ x: number; y: number } | null>(null);

  return {
    onTouchStart: (e: TouchEvent) => {
      const t = e.touches[0];
      start.current = { x: t.clientX, y: t.clientY };
    },
    onTouchEnd: (e: TouchEvent) => {
      if (!start.current) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - start.current.x;
      const dy = t.clientY - start.current.y;
      start.current = null;

      if (Math.abs(dx) > Math.abs(dy)) {
        if (dx <= -threshold) onSwipeLeft?.();
        else if (dx >= threshold) onSwipeRight?.();
      } else {
        if (dy <= -threshold) onSwipeUp?.();
        else if (dy >= threshold) onSwipeDown?.();
      }
    },
  };
}
