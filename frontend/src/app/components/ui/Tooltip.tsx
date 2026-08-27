"use client";

import { Info } from "lucide-react";
import {
  useId,
  useRef,
  useState,
  useEffect,
  type ReactNode,
  createPortal,
} from "react";

type Placement =
  | "top"
  | "top-start"
  | "top-end"
  | "bottom"
  | "bottom-start"
  | "bottom-end"
  | "left"
  | "left-start"
  | "left-end"
  | "right"
  | "right-start"
  | "right-end";

type TooltipProps = {
  content: ReactNode;
  label?: string;
  iconClassName?: string;
  className?: string;
  placement?: Placement;
  offset?: number;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  disableHover?: boolean;
};

const PLACEMENTS: Placement[] = [
  "top",
  "top-start",
  "top-end",
  "bottom",
  "bottom-start",
  "bottom-end",
  "left",
  "left-start",
  "left-end",
  "right",
  "right-start",
  "right-end",
];

function getPlacementStyles(
  placement: Placement,
  triggerRect: DOMRect,
  tooltipRect: DOMRect,
  offset: number,
): { top: number; left: number; transform: string } {
  const { width: triggerWidth, height: triggerHeight } = triggerRect;
  const { width: tooltipWidth, height: tooltipHeight } = tooltipRect;

  let top = 0;
  let left = 0;
  let transform = "";

  switch (placement) {
    case "top":
      top = triggerRect.top - tooltipHeight - offset;
      left = triggerRect.left + triggerWidth / 2 - tooltipWidth / 2;
      transform = "translateX(-50%)";
      break;
    case "top-start":
      top = triggerRect.top - tooltipHeight - offset;
      left = triggerRect.left;
      transform = "translateX(0)";
      break;
    case "top-end":
      top = triggerRect.top - tooltipHeight - offset;
      left = triggerRect.right - tooltipWidth;
      transform = "translateX(0)";
      break;
    case "bottom":
      top = triggerRect.bottom + offset;
      left = triggerRect.left + triggerWidth / 2 - tooltipWidth / 2;
      transform = "translateX(-50%)";
      break;
    case "bottom-start":
      top = triggerRect.bottom + offset;
      left = triggerRect.left;
      transform = "translateX(0)";
      break;
    case "bottom-end":
      top = triggerRect.bottom + offset;
      left = triggerRect.right - tooltipWidth;
      transform = "translateX(0)";
      break;
    case "left":
      top = triggerRect.top + triggerHeight / 2 - tooltipHeight / 2;
      left = triggerRect.left - tooltipWidth - offset;
      transform = "translateY(-50%)";
      break;
    case "left-start":
      top = triggerRect.top;
      left = triggerRect.left - tooltipWidth - offset;
      transform = "translateY(0)";
      break;
    case "left-end":
      top = triggerRect.bottom - tooltipHeight;
      left = triggerRect.left - tooltipWidth - offset;
      transform = "translateY(0)";
      break;
    case "right":
      top = triggerRect.top + triggerHeight / 2 - tooltipHeight / 2;
      left = triggerRect.right + offset;
      transform = "translateY(-50%)";
      break;
    case "right-start":
      top = triggerRect.top;
      left = triggerRect.right + offset;
      transform = "translateY(0)";
      break;
    case "right-end":
      top = triggerRect.bottom - tooltipHeight;
      left = triggerRect.right + offset;
      transform = "translateY(0)";
      break;
  }

  return { top, left, transform };
}

function getOppositePlacement(placement: Placement): Placement {
  const opposites: Record<Placement, Placement> = {
    top: "bottom",
    "top-start": "bottom-start",
    "top-end": "bottom-end",
    bottom: "top",
    "bottom-start": "top-start",
    "bottom-end": "top-end",
    left: "right",
    "left-start": "right-start",
    "left-end": "right-end",
    right: "left",
    "right-start": "left-start",
    "right-end": "left-end",
  };
  return opposites[placement];
}

function getVariations(placement: Placement): Placement[] {
  const base = placement.split("-")[0];
  const variants: Record<string, Placement[]> = {
    top: ["top", "top-start", "top-end", "bottom", "bottom-start", "bottom-end"],
    bottom: ["bottom", "bottom-start", "bottom-end", "top", "top-start", "top-end"],
    left: ["left", "left-start", "left-end", "right", "right-start", "right-end"],
    right: ["right", "right-start", "right-end", "left", "left-start", "left-end"],
  };
  return variants[base] ?? PLACEMENTS;
}

function isWithinViewport(
  top: number,
  left: number,
  width: number,
  height: number,
  padding = 8,
): boolean {
  return (
    top >= padding &&
    left >= padding &&
    top + height <= window.innerHeight - padding &&
    left + width <= window.innerWidth - padding
  );
}

export function Tooltip({
  content,
  label = "More info",
  iconClassName,
  className,
  placement: initialPlacement = "top",
  offset = 8,
  open: controlledOpen,
  onOpenChange,
  disableHover = false,
}: TooltipProps) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number; transform: string }>({
    top: 0,
    left: 0,
    transform: "translateX(-50%)",
  });
  const [currentPlacement, setCurrentPlacement] = useState<Placement>(initialPlacement);
  const [tooltipRect, setTooltipRect] = useState<DOMRect | null>(null);

  const isControlled = controlledOpen !== undefined;

  const updatePosition = () => {
    if (!triggerRef.current || !tooltipRef.current) return;

    const triggerRect = triggerRef.current.getBoundingClientRect();
    const currentTooltipRect = tooltipRef.current.getBoundingClientRect();
    setTooltipRect(currentTooltipRect);

    let bestPlacement = currentPlacement;
    let bestPosition = { top: 0, left: 0, transform: "" };
    let foundValidPosition = false;

    const variations = getVariations(initialPlacement);

    for (const testPlacement of variations) {
      const testPosition = getPlacementStyles(
        testPlacement,
        triggerRect,
        currentTooltipRect,
        offset,
      );

      if (
        isWithinViewport(
          testPosition.top,
          testPosition.left,
          currentTooltipRect.width,
          currentTooltipRect.height,
        )
      ) {
        bestPlacement = testPlacement;
        bestPosition = testPosition;
        foundValidPosition = true;
        break;
      }
    }

    if (!foundValidPosition) {
      const fallbackPosition = getPlacementStyles(
        initialPlacement,
        triggerRect,
        currentTooltipRect,
        offset,
      );
      bestPosition = fallbackPosition;
    }

    setCurrentPlacement(bestPlacement);
    setPosition(bestPosition);
  };

  useEffect(() => {
    if (!isOpen) return;

    updatePosition();

    const handleScroll = () => updatePosition();
    const handleResize = () => updatePosition();

    window.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("resize", handleResize, { passive: true });

    return () => {
      window.removeEventListener("scroll", handleScroll);
      window.removeEventListener("resize", handleResize);
    };
  }, [isOpen, offset, initialPlacement]);

  useEffect(() => {
    if (isOpen) {
      updatePosition();
    }
  }, [content]);

  const handleOpen = () => {
    if (!isControlled) setIsOpen(true);
    onOpenChange?.(true);
  };

  const handleClose = () => {
    if (!isControlled) setIsOpen(false);
    onOpenChange?.(false);
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      handleClose();
      triggerRef.current?.focus();
    }
  };

  const tooltipContent = (
    <div
      ref={tooltipRef}
      id={id}
      role="tooltip"
      className="rounded-2xl border border-zinc-200 bg-white p-3 text-xs leading-5 text-zinc-700 shadow-lg shadow-zinc-900/10 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200 dark:shadow-none"
      style={{
        position: "fixed",
        top: position.top,
        left: position.left,
        transform: position.transform,
        zIndex: 50,
        minWidth: "160px",
        maxWidth: "256px",
        pointerEvents: "none",
      }}
    >
      {content}
    </div>
  );

  const trigger = (
    <button
      ref={triggerRef}
      type="button"
      aria-label={label}
      aria-describedby={isOpen ? id : undefined}
      aria-expanded={isOpen}
      className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-zinc-400 transition hover:text-indigo-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-zinc-950 ${className ?? ""}`}
      onMouseEnter={disableHover ? undefined : handleOpen}
      onMouseLeave={disableHover ? undefined : handleClose}
      onFocus={handleOpen}
      onBlur={handleClose}
      onKeyDown={handleKeyDown}
    >
      <Info className={`h-4 w-4 ${iconClassName ?? ""}`} />
    </button>
  );

  if (isControlled) {
    return (
      <span className="relative inline-flex items-center">
        {trigger}
        {isOpen && createPortal(tooltipContent, document.body)}
      </span>
    );
  }

  return (
    <span className="group relative inline-flex items-center">
      {trigger}
      {isOpen && createPortal(tooltipContent, document.body)}
    </span>
  );
}