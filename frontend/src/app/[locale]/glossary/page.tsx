/**
 * Glossary page — /[locale]/glossary
 *
 * Renders a searchable, locale-aware A–Z reference of financial terms.
 * - All definitions come from the Glossary namespace in the message files.
 * - Search is client-only; no backend call is required.
 * - Terms are grouped alphabetically for scanability.
 * - The page never modifies or replaces any contract language or financial
 *   disclosures shown elsewhere in the app.
 */

import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { GlossaryPageClient } from "./GlossaryPageClient";
import { GLOSSARY_TERM_KEYS } from "../../components/glossary/GlossaryTerm";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Glossary" });
  return {
    title: `${t("pageTitle")} — RemitLend`,
    description: t("pageDescription"),
  };
}

export default async function GlossaryPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Glossary" });

  // Build the full term list server-side so the page is SSR-safe and
  // discoverable by search engines.  The client component takes over for
  // the interactive search filter.
  const terms = GLOSSARY_TERM_KEYS.map((key) => ({
    key,
    term: t(`terms.${key}.term`),
    definition: t(`terms.${key}.definition`),
  }));

  return (
    <GlossaryPageClient
      terms={terms}
      pageTitle={t("pageTitle")}
      pageDescription={t("pageDescription")}
      searchPlaceholder={t("searchPlaceholder")}
      noResultsTemplate={t.raw("noResults") as string}
    />
  );
}
