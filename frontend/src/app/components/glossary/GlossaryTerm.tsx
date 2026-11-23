"use client";

/**
 * GlossaryTerm — contextual, locale-aware term explanation (#843).
 *
 * Wraps any child element (usually a label text node) with a subtle underline
 * that reveals a plain-language definition on hover/focus. The definition is
 * pulled from the Glossary translation namespace so it adapts automatically to
 * the user's locale (en / es / tl).
 *
 * Usage:
 *   <GlossaryTerm termKey="apr">APR</GlossaryTerm>
 *   <GlossaryTerm termKey="collateral" placement="bottom">
 *     Collateral ratio
 *   </GlossaryTerm>
 *
 * Disclosure guarantee:
 *   - The tooltip only *supplements* labels; the original label text is never
 *     replaced or hidden.
 *   - The tooltip does NOT modify any contract language or financial disclosures.
 *   - Definitions are sourced exclusively from the Glossary namespace in the
 *     reviewed message files; they cannot be overridden at the call site.
 */

import { useTranslations } from "next-intl";
import { HelpCircle } from "lucide-react";
import type { ReactNode } from "react";
import { Tooltip } from "../ui/floating/Tooltip";
import type { Placement } from "../ui/floating/useFloating";

/** All supported glossary term keys.  Add a key here when you add it to messages/. */
export const GLOSSARY_TERM_KEYS = [
  "apr",
  "apy",
  "principal",
  "interest",
  "accruedInterest",
  "originationFee",
  "effectiveApr",
  "collateral",
  "collateralRatio",
  "healthFactor",
  "liquidationThreshold",
  "liquidation",
  "utilizationRate",
  "creditScore",
  "remittance",
  "amortization",
  "lateFee",
  "withdrawal",
  "cooldown",
  "yield",
  "shareOfPool",
  "default",
] as const;

export type GlossaryTermKey = (typeof GLOSSARY_TERM_KEYS)[number];

interface GlossaryTermProps {
  /** The glossary term key — must exist in Glossary.terms.* in all locale files. */
  termKey: GlossaryTermKey;
  /** The visible label text.  Defaults to the locale-translated term name. */
  children?: ReactNode;
  placement?: Placement;
  /** Hover-open delay in ms (default 150). */
  delay?: number;
  /**
   * Render as a plain underline instead of an icon button.
   * Use `inline` when the trigger is already within a sentence.
   * Use `icon` (default) when the trigger is a standalone label that shouldn't
   * be visually underlined.
   */
  variant?: "inline" | "icon";
}

/**
 * Builds the tooltip definition content.  Returned as a React element so it
 * can display the term name in bold followed by the definition.
 */
function DefinitionPanel({
  termName,
  definition,
}: {
  termName: string;
  definition: string;
}) {
  return (
    <span>
      <strong className="block font-semibold">{termName}</strong>
      <span className="mt-0.5 block font-normal leading-snug">{definition}</span>
    </span>
  );
}

export function GlossaryTerm({
  termKey,
  children,
  placement = "top",
  delay = 150,
  variant = "icon",
}: GlossaryTermProps) {
  const t = useTranslations("Glossary");

  const termName = t(`terms.${termKey}.term`);
  const definition = t(`terms.${termKey}.definition`);
  const tooltipLabel = t("tooltipLabel", { term: termName });

  const content = <DefinitionPanel termName={termName} definition={definition} />;

  if (variant === "inline") {
    return (
      <Tooltip content={content} placement={placement} delay={delay}>
        <span
          className="cursor-help underline decoration-dotted decoration-zinc-400 underline-offset-2 dark:decoration-zinc-600"
          aria-label={tooltipLabel}
        >
          {children ?? termName}
        </span>
      </Tooltip>
    );
  }

  // icon variant: children + a small info icon button
  return (
    <span className="inline-flex items-center gap-1">
      {children ?? termName}
      <Tooltip content={content} placement={placement} delay={delay}>
        <button
          type="button"
          aria-label={tooltipLabel}
          className="inline-flex items-center rounded-full p-0.5 text-zinc-400 hover:text-zinc-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-zinc-600 dark:hover:text-zinc-400"
        >
          <HelpCircle className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </Tooltip>
    </span>
  );
}
