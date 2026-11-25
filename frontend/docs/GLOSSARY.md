# Frontend Glossary — Plain-Language Term Explanations

> Issue #843 — frontend: add plain-language glossary and contextual term explanations

## Overview

The glossary system provides reviewed, locale-aware plain-language definitions
for the protocol, fee, yield, and credit terms used throughout RemitLend. It
operates at two levels:

1. **Contextual `GlossaryTerm` tooltips** — an inline `<GlossaryTerm>` component
   that wraps any label and reveals a locale-correct definition on hover or focus,
   without obscuring the label or altering any material disclosure.

2. **Standalone `/[locale]/glossary` page** — a searchable A–Z reference of
   every defined term, server-rendered for SEO and locale metadata, with a
   client-side live-search filter.

---

## Disclosure guarantee

The glossary system is designed to *supplement*, never *replace*, financial
disclosures or contract language:

- Tooltip definitions are sourced exclusively from the reviewed `Glossary`
  namespace in the message files. They cannot be overridden at the call site.
- Labels that carry material financial figures (disbursed amount, total
  repayment, effective APR value) are **not** wrapped with `GlossaryTerm`.
  Only the term names (e.g. "Origination fee", "Interest over the term") are
  annotated.
- The `LoanCostDisclosurePanel` nominal/effective APR prose wraps the term
  names `Nominal APR` and `effective APR` with glossary tooltips, but the
  numeric values are `<strong>` text that remains unmodified.
- No new network requests are made when a tooltip opens or the glossary page
  is viewed — definitions are compiled at build time from the message files.

---

## Supported locales

| Locale | Language | File |
|---|---|---|
| `en` | English | `frontend/messages/en.json` |
| `es` | Español | `frontend/messages/es.json` |
| `tl` | Tagalog | `frontend/messages/tl.json` |

All 23 term keys exist in all three locale files. The `scripts/check-i18n.mjs`
parity script validates this on every CI run.

---

## Defined terms (23)

| Key | English term |
|---|---|
| `apr` | APR |
| `apy` | APY |
| `principal` | Principal |
| `interest` | Interest |
| `accruedInterest` | Accrued interest |
| `originationFee` | Origination fee |
| `effectiveApr` | Effective APR |
| `collateral` | Collateral |
| `collateralRatio` | Collateral ratio |
| `healthFactor` | Health factor |
| `liquidationThreshold` | Liquidation threshold |
| `liquidation` | Liquidation |
| `utilizationRate` | Utilization rate |
| `creditScore` | Credit score |
| `remittance` | Remittance |
| `amortization` | Amortization |
| `lateFee` | Late fee |
| `withdrawal` | Withdrawal |
| `cooldown` | Withdrawal cooldown |
| `yield` | Yield |
| `shareOfPool` | Share of pool |
| `default` | Loan default |

---

## Component API

### `GlossaryTerm`

Located at `src/app/components/glossary/GlossaryTerm.tsx`.

```tsx
<GlossaryTerm
  termKey="apr"           // Required. Must be a key in GLOSSARY_TERM_KEYS.
  variant="icon"          // "icon" (default) | "inline"
  placement="top"         // Any Placement from useFloating
  delay={150}             // Hover-open delay in ms
>
  APR                     // Optional. Falls back to the locale term name.
</GlossaryTerm>
```

**`variant="icon"`** (default): renders `{children}` followed by a small
`HelpCircle` icon button. Best for standalone labels in stat cards, table
headers, or form fields where adding an underline would look odd.

**`variant="inline"`**: renders `{children}` with a dotted underline. Best for
terms that appear mid-sentence in prose or disclosure text.

Both variants are keyboard-accessible: the tooltip opens on focus and closes on
Escape. The floating panel renders into `document.body` via `createPortal` and
uses the shared `useFloating` positioning engine (flip + shift + ResizeObserver).

---

## Where GlossaryTerm is used

| Location | Terms annotated |
|---|---|
| `LendPageClient.tsx` — pool stats | `utilizationRate`, `apy` |
| `LendPageClient.tsx` — my deposits | `shareOfPool`, `yield` |
| `LoanCostDisclosurePanel.tsx` — row labels | `principal`, `originationFee`, `interest`, `accruedInterest`, `lateFee` |
| `LoanCostDisclosurePanel.tsx` — APR prose | `apr` (nominal), `effectiveApr` |

---

## Standalone glossary page

**Route:** `/[locale]/glossary`

**Server component (`page.tsx`):**
- Calls `getTranslations({ locale, namespace: "Glossary" })` to build the full
  term list at request time (SSR).
- Sets locale-aware `<title>` and `<meta description>` via `generateMetadata`.
- Passes the pre-built term list to the client shell.

**Client shell (`GlossaryPageClient.tsx`):**
- Accepts the term list as a prop (no `useTranslations` call needed — avoids
  client-side message loading).
- Maintains a `query` state string; filters the term list on every keystroke.
- Groups matching terms alphabetically under letter `<h2>` headings.
- Renders each term as a `<dt>` / `<dd>` pair inside a `<dl>`.
- Shows a no-results message when the filtered list is empty, with the user's
  query safely interpolated (no `dangerouslySetInnerHTML`).
- `role="status"` + `aria-live="polite"` count announces filter result changes
  to screen readers.

---

## Adding a new term

1. Add the key to `GLOSSARY_TERM_KEYS` in `GlossaryTerm.tsx`.
2. Add the term object `{ term, definition }` under `Glossary.terms.<key>` in
   all three message files (`en.json`, `es.json`, `tl.json`).
3. Run `npm run i18n:check` from the `frontend/` directory to verify parity.
4. Optionally, add a `LABEL_TO_GLOSSARY_KEY` entry in
   `LoanCostDisclosurePanel.tsx` if the term appears as a row label.

---

## Testing

Unit and integration tests live at:

```
frontend/src/app/components/glossary/__tests__/GlossaryTerm.test.tsx
```

Coverage includes:
- Icon and inline variant rendering and accessibility
- Locale-specific term names (en, es, tl)
- Completeness: every key in `GLOSSARY_TERM_KEYS` has a non-empty term and
  definition in all three locale files
- `GlossaryPageClient`: full render, search filter, no-results message,
  alphabet grouping, clearing search
- Disclosure guarantee: original label text is never replaced

Run with:

```bash
cd frontend
npm test -- --testPathPattern=GlossaryTerm
```

Storybook stories at:
```
frontend/src/app/components/glossary/GlossaryTerm.stories.tsx
```

---

## Schema / migration implications

No backend schema changes. The glossary is entirely frontend-only:
- No database table or API endpoint.
- No new environment variables.
- No changes to the OpenAPI spec.
- Locale message files (`messages/*.json`) are the only authoritative store.

---

## Compatibility

- Next.js 14 App Router (RSC + client components).
- `next-intl` v4 — `getTranslations` (server), `useTranslations` (client).
- The floating tooltip engine (`useFloating.ts`) is the same one used by
  `Tooltip` and `Popover`; no new positioning dependency was introduced.
- Zero new npm packages.
