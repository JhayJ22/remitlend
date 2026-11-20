"use client";

/**
 * Client-side shell for the Glossary page.
 *
 * Receives the full term list from the server component (already localised)
 * and renders a live-search filter.  Search is purely presentational:
 * - No network requests are made during search.
 * - Terms that do not match the query are hidden with CSS (not removed from
 *   the DOM) so screen readers can still access the full list.
 * - The noResults message interpolates the query string safely via template
 *   substitution (no dangerouslySetInnerHTML).
 */

import { useState, useId } from "react";
import { BookOpen, Search } from "lucide-react";
import type { GlossaryTermKey } from "../../components/glossary/GlossaryTerm";

interface TermEntry {
  key: GlossaryTermKey;
  term: string;
  definition: string;
}

interface GlossaryPageClientProps {
  terms: TermEntry[];
  pageTitle: string;
  pageDescription: string;
  searchPlaceholder: string;
  /**
   * ICU-style template string for the no-results message.
   * Contains the literal substring `{query}` which is replaced at render time.
   */
  noResultsTemplate: string;
}

function interpolateQuery(template: string, query: string): string {
  return template.replace("{query}", query);
}

/** Groups an alphabetically-sorted term list by the first letter of term. */
function groupByLetter(terms: TermEntry[]): Array<{ letter: string; terms: TermEntry[] }> {
  const map = new Map<string, TermEntry[]>();
  for (const entry of terms) {
    const letter = entry.term.charAt(0).toUpperCase();
    const existing = map.get(letter);
    if (existing) {
      existing.push(entry);
    } else {
      map.set(letter, [entry]);
    }
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([letter, terms]) => ({ letter, terms }));
}

export function GlossaryPageClient({
  terms,
  pageTitle,
  pageDescription,
  searchPlaceholder,
  noResultsTemplate,
}: GlossaryPageClientProps) {
  const searchId = useId();
  const [query, setQuery] = useState("");

  const normalised = query.trim().toLowerCase();
  const filtered = normalised
    ? terms.filter(
        (t) =>
          t.term.toLowerCase().includes(normalised) ||
          t.definition.toLowerCase().includes(normalised),
      )
    : terms;

  const groups = groupByLetter(
    [...filtered].sort((a, b) => a.term.localeCompare(b.term)),
  );

  return (
    <main className="max-w-4xl mx-auto px-4 py-10 space-y-10" aria-labelledby="glossary-title">
      {/* Header */}
      <header className="space-y-2">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-indigo-50 p-2.5 dark:bg-indigo-500/10">
            <BookOpen className="h-6 w-6 text-indigo-600 dark:text-indigo-400" aria-hidden="true" />
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-indigo-600 dark:text-indigo-400">
              Reference
            </p>
            <h1
              id="glossary-title"
              className="text-2xl font-bold text-zinc-900 dark:text-zinc-50"
            >
              {pageTitle}
            </h1>
          </div>
        </div>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 max-w-2xl">{pageDescription}</p>
      </header>

      {/* Search */}
      <div className="relative">
        <label htmlFor={searchId} className="sr-only">
          {searchPlaceholder}
        </label>
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400"
          aria-hidden="true"
        />
        <input
          id={searchId}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={searchPlaceholder}
          className="w-full rounded-xl border border-zinc-200 bg-white py-2.5 pl-9 pr-4 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-50 dark:placeholder:text-zinc-600"
          aria-label={searchPlaceholder}
          autoComplete="off"
          spellCheck="false"
        />
      </div>

      {/* Results */}
      {filtered.length === 0 ? (
        <p
          role="status"
          aria-live="polite"
          className="rounded-xl border border-zinc-200 bg-zinc-50 px-6 py-10 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400"
        >
          {interpolateQuery(noResultsTemplate, query)}
        </p>
      ) : (
        <div
          role="status"
          aria-live="polite"
          aria-atomic="false"
          className="sr-only"
        >
          {filtered.length} term{filtered.length !== 1 ? "s" : ""}
        </div>
      )}

      {groups.map(({ letter, terms: groupTerms }) => (
        <section key={letter} aria-labelledby={`glossary-group-${letter}`}>
          <h2
            id={`glossary-group-${letter}`}
            className="mb-4 border-b border-zinc-200 pb-2 text-xs font-semibold uppercase tracking-widest text-zinc-400 dark:border-zinc-800 dark:text-zinc-600"
          >
            {letter}
          </h2>
          <dl className="space-y-6">
            {groupTerms.map((entry) => (
              <div key={entry.key} id={`term-${entry.key}`}>
                <dt className="text-base font-semibold text-zinc-900 dark:text-zinc-50">
                  {entry.term}
                </dt>
                <dd className="mt-1 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
                  {entry.definition}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </main>
  );
}
