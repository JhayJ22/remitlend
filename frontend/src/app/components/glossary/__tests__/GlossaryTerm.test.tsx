/**
 * Tests for GlossaryTerm and GlossaryPageClient (#843).
 *
 * Coverage:
 *  - GlossaryTerm renders the locale-correct term name and aria-label
 *  - GlossaryTerm (icon variant): trigger button is accessible
 *  - GlossaryTerm (inline variant): trigger has dotted underline class
 *  - GlossaryTerm falls back to term name when no children are passed
 *  - GlossaryTerm definitions are non-empty for every supported term key
 *  - GlossaryTerm does not duplicate/override the label text
 *  - GlossaryPageClient: renders all terms
 *  - GlossaryPageClient: search filters by term name and definition
 *  - GlossaryPageClient: no-results message interpolates the query
 *  - GlossaryPageClient: clearing search restores full list
 *  - GlossaryPageClient: results are alphabetically grouped
 *  - Locale parity: all term keys exist in en, es, and tl message files
 */

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import en from "../../../../../messages/en.json";
import es from "../../../../../messages/es.json";
import tl from "../../../../../messages/tl.json";
import { GlossaryTerm, GLOSSARY_TERM_KEYS, type GlossaryTermKey } from "../GlossaryTerm";
import { GlossaryPageClient } from "../.././../[locale]/glossary/GlossaryPageClient";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderWithIntl(ui: React.ReactElement, locale: "en" | "es" | "tl" = "en") {
  const messages = locale === "en" ? en : locale === "es" ? es : tl;
  return render(
    <NextIntlClientProvider locale={locale} messages={messages}>
      {ui}
    </NextIntlClientProvider>,
  );
}

/** Builds a minimal terms array matching what the server component produces. */
function makeTerms() {
  const glossary = en.Glossary.terms as Record<string, { term: string; definition: string }>;
  return GLOSSARY_TERM_KEYS.map((key) => ({
    key,
    term: glossary[key]!.term,
    definition: glossary[key]!.definition,
  }));
}

const TERMS = makeTerms();

// ---------------------------------------------------------------------------
// GlossaryTerm — icon variant
// ---------------------------------------------------------------------------

describe("GlossaryTerm (icon variant)", () => {
  it("renders the children label text", () => {
    renderWithIntl(<GlossaryTerm termKey="apr">APR</GlossaryTerm>);
    expect(screen.getByText("APR")).toBeInTheDocument();
  });

  it("renders an accessible icon button with aria-label", () => {
    renderWithIntl(<GlossaryTerm termKey="apr">APR</GlossaryTerm>);
    // en.Glossary.terms.apr.term is "APR", so label is "What is APR?"
    const btn = screen.getByRole("button", { name: /What is APR\?/i });
    expect(btn).toBeInTheDocument();
  });

  it("falls back to the locale term name when no children are passed", () => {
    renderWithIntl(<GlossaryTerm termKey="collateral" />);
    // Should render the English term "Collateral"
    expect(screen.getByText("Collateral")).toBeInTheDocument();
  });

  it("does not remove or replace the label text", () => {
    renderWithIntl(<GlossaryTerm termKey="apy">Current APY</GlossaryTerm>);
    // Original label text must still be present
    expect(screen.getByText("Current APY")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// GlossaryTerm — inline variant
// ---------------------------------------------------------------------------

describe("GlossaryTerm (inline variant)", () => {
  it("renders with dotted underline class", () => {
    renderWithIntl(
      <GlossaryTerm termKey="collateral" variant="inline">
        Collateral
      </GlossaryTerm>,
    );
    const span = screen.getByText("Collateral");
    expect(span.className).toContain("decoration-dotted");
  });

  it("has the aria-label for screen readers", () => {
    renderWithIntl(
      <GlossaryTerm termKey="collateral" variant="inline">
        Collateral
      </GlossaryTerm>,
    );
    const span = screen.getByLabelText(/What is Collateral\?/i);
    expect(span).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Locale-specific rendering
// ---------------------------------------------------------------------------

describe("GlossaryTerm locale rendering", () => {
  it("renders the Spanish term name when locale is es", () => {
    renderWithIntl(<GlossaryTerm termKey="collateral" />, "es");
    // es term for collateral is "Garantía"
    expect(screen.getByText("Garantía")).toBeInTheDocument();
  });

  it("renders the Tagalog term name when locale is tl", () => {
    renderWithIntl(<GlossaryTerm termKey="remittance" />, "tl");
    // tl term for remittance is "Remitansa"
    expect(screen.getByText("Remitansa")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// All term keys have non-empty definitions
// ---------------------------------------------------------------------------

describe("GlossaryTerm — completeness check", () => {
  const glossary = en.Glossary.terms as Record<string, { term: string; definition: string }>;

  it.each(GLOSSARY_TERM_KEYS)(
    "term key '%s' has a non-empty term name and definition in en",
    (key) => {
      expect(glossary[key]).toBeDefined();
      expect(glossary[key]!.term.length).toBeGreaterThan(0);
      expect(glossary[key]!.definition.length).toBeGreaterThan(20);
    },
  );
});

// ---------------------------------------------------------------------------
// Locale parity — all keys exist in all three locales
// ---------------------------------------------------------------------------

describe("Locale parity", () => {
  const esGlossary = es.Glossary.terms as Record<string, { term: string; definition: string }>;
  const tlGlossary = tl.Glossary.terms as Record<string, { term: string; definition: string }>;

  it.each(GLOSSARY_TERM_KEYS)("key '%s' exists in es.json", (key) => {
    expect(esGlossary[key]).toBeDefined();
    expect(esGlossary[key]!.term.length).toBeGreaterThan(0);
    expect(esGlossary[key]!.definition.length).toBeGreaterThan(20);
  });

  it.each(GLOSSARY_TERM_KEYS)("key '%s' exists in tl.json", (key) => {
    expect(tlGlossary[key]).toBeDefined();
    expect(tlGlossary[key]!.term.length).toBeGreaterThan(0);
    expect(tlGlossary[key]!.definition.length).toBeGreaterThan(20);
  });
});

// ---------------------------------------------------------------------------
// GlossaryPageClient
// ---------------------------------------------------------------------------

function renderPage(overrides: Partial<React.ComponentProps<typeof GlossaryPageClient>> = {}) {
  return render(
    <GlossaryPageClient
      terms={TERMS}
      pageTitle="Financial Glossary"
      pageDescription="Plain-language explanations."
      searchPlaceholder="Search terms…"
      noResultsTemplate='No terms match "{query}". Try a broader search.'
      {...overrides}
    />,
  );
}

describe("GlossaryPageClient", () => {
  it("renders the page title and description", () => {
    renderPage();
    expect(screen.getByRole("heading", { name: "Financial Glossary" })).toBeInTheDocument();
    expect(screen.getByText("Plain-language explanations.")).toBeInTheDocument();
  });

  it("renders all term definitions", () => {
    renderPage();
    for (const entry of TERMS) {
      expect(screen.getByText(entry.term)).toBeInTheDocument();
    }
  });

  it("filters terms by name on search input", async () => {
    renderPage();
    const input = screen.getByRole("searchbox");
    await userEvent.type(input, "apy");
    // "APY" term should be visible
    expect(screen.getByText("APY")).toBeInTheDocument();
    // "Collateral" should not be in a visible dt (filtered out)
    expect(screen.queryByText("Collateral")).not.toBeInTheDocument();
  });

  it("filters terms by definition text on search input", async () => {
    renderPage();
    const input = screen.getByRole("searchbox");
    // "compounding" only appears in APY definition
    await userEvent.type(input, "compounding");
    expect(screen.getByText("APY")).toBeInTheDocument();
    expect(screen.queryByText("Collateral")).not.toBeInTheDocument();
  });

  it("shows the no-results message with the query interpolated", async () => {
    renderPage();
    const input = screen.getByRole("searchbox");
    await userEvent.type(input, "xyzzy999");
    expect(
      screen.getByText(/No terms match "xyzzy999"\./),
    ).toBeInTheDocument();
  });

  it("restores the full list when search is cleared", async () => {
    renderPage();
    const input = screen.getByRole("searchbox");
    await userEvent.type(input, "apr");
    expect(screen.queryByText("Collateral")).not.toBeInTheDocument();
    await userEvent.clear(input);
    expect(screen.getByText("Collateral")).toBeInTheDocument();
  });

  it("groups terms alphabetically under letter headings", () => {
    renderPage();
    // Every group heading should be a single uppercase letter
    const headings = screen.getAllByRole("heading", { level: 2 });
    for (const h of headings) {
      expect(h.textContent).toMatch(/^[A-Z]$/);
    }
    // "A" should come before "C"
    const letters = headings.map((h) => h.textContent);
    const aIdx = letters.indexOf("A");
    const cIdx = letters.indexOf("C");
    if (aIdx >= 0 && cIdx >= 0) {
      expect(aIdx).toBeLessThan(cIdx);
    }
  });

  it("renders each term in a dl with dt and dd", () => {
    renderPage();
    const list = screen.getByRole("term", { hidden: false }).closest("dl");
    expect(list).toBeInTheDocument();
  });

  it("renders a search input with accessible label", () => {
    renderPage();
    const input = screen.getByRole("searchbox");
    expect(input).toHaveAttribute("placeholder", "Search terms…");
  });
});

// ---------------------------------------------------------------------------
// Disclosure guarantee — GlossaryTerm must not override label text
// ---------------------------------------------------------------------------

describe("Disclosure guarantee", () => {
  it("does not replace the label text with the definition", () => {
    renderWithIntl(
      <GlossaryTerm termKey="originationFee">Origination fee</GlossaryTerm>,
    );
    // Label text must be present
    expect(screen.getByText("Origination fee")).toBeInTheDocument();
    // The definition must NOT appear in the DOM at rest (tooltip is not open)
    // Note: the tooltip mounts on hover via createPortal; at rest it is not in the document
    expect(
      screen.queryByText(/one-time fee charged when your loan is created/i),
    ).not.toBeInTheDocument();
  });
});
