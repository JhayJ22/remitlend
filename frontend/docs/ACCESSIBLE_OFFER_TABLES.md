# Accessible offer comparison tables

Issue #841 adds a keyboard-operable comparison surface for loan and pool offers at `/offers`. The implementation is UI-only: it derives rows from the existing `/loans` and `/pool/stats` API responses without changing either contract.

## Source of truth and data flow

- `frontend/src/lib/offerRows.ts` adapts `Loan[]` and `PoolStats` into `OfferRow[]`. Loan amounts, currency codes, interest rates, and terms are copied unchanged. Pool APY (`0.08`) is converted only for display (`8.00%`); `totalDeposits` remains in its source unit.
- `frontend/src/lib/offerComparison.ts` is the pure state machine for sorting and filtering. It validates every action before mutating view state and never performs I/O.
- `frontend/src/app/components/offers/OfferComparisonTable.tsx` renders one semantic table, a responsive card alternative, filter controls, and a polite live summary.
- `frontend/src/app/[locale]/offers/page.tsx` supplies live data from the existing React Query hooks. The lender portal links to this page.

## Supported states

| State           | Behavior                                                                                       |
| --------------- | ---------------------------------------------------------------------------------------------- |
| Loading         | `role="status"` message; no table or filters are rendered.                                     |
| Error           | `role="alert"` message; no stale or partial rows are displayed.                                |
| Empty           | `role="status"` message after valid filters exclude every row.                                 |
| Populated       | Semantic table plus responsive cards; live summary describes visible count, sort, and filters. |
| Rejected action | Invalid sort key or unsafe filter value leaves rows/state unchanged and announces a warning.   |

## Input constraints and side effects

- Sort keys are restricted to `name`, `kind`, `amount`, `ratePercent`, `termDays`, and `status`; any other key is rejected.
- Filter values are limited to 80 characters and `A–Z a–z 0–9 space . _ : -`. `kind` accepts only `all`, `loan`, or `pool`. Markup, paths, and null bytes are rejected.
- Text queries are trimmed only when matching; the input retains exactly what the user typed, so multi-word typing and focus are preserved.
- Sorting and filtering are local view operations. They do not submit transactions, mutate loan/pool state, or create partial financial side effects.
- Rows without a term (flexible pool withdrawal) sort last in both directions.

## Authorization, consent, and keyboard behavior

- The page uses the same public API reads as the existing lender portal; no new permission or consent is required.
- Column-header buttons are reachable by Tab and operable with Enter/Space. Focus is restored to the activated header after the state update.
- Filter controls are outside the reordered row set and keep focus while typing or selecting.
- The table has an `sr-only` caption, `scope="col"` headers with `aria-sort`, `scope="row"` offer names, and `aria-describedby` pointing to the live summary.
- Below `md`, the table is hidden and equivalent `<article>`/`<dl>` cards are shown; both layouts expose the same values.

## API, event, persistence, and UI consistency

- API: no new endpoint, field, status code, or money unit. Existing `Loan` and `PoolStats` shapes remain authoritative.
- Events: no new event is emitted. Sorting/filtering are local UI state, not domain events.
- Persistence: no stored schema changes. Filter choices are not persisted across reloads.
- UI: both responsive presentations are derived from the same `visibleRows` array and the same `cellValue` formatter, so amounts, rates, and status cannot drift between layouts.

## Compatibility and migration

- `/offers` is an additive route; the existing lender portal remains unchanged apart from a link.
- Locale messages add an `Offers` namespace to `en`, `es`, and `tl`. `npm run i18n:check` enforces key parity and non-empty copy.
- Adding a new sortable column requires adding its key to `SORT_KEYS`, `OFFER_SORT_KEYS`, and all locale `columns` messages before release.
- No API or stored-schema migration is needed. Consumers of `/loans` and `/pool/stats` are unaffected.

## Validation evidence

From `frontend/`:

```bash
npm run i18n:check
npm run test:offer-tables
npx jest --runInBand LendPageClient
```

- `i18n:check`: translation key parity passed for `en`, `es`, `tl`.
- `test:offer-tables`: 2 suites, 16 tests passed. Covers successful sorting/filtering, exact money units, keyboard focus retention, `aria-sort` disclosure, semantic headers/caption, responsive cards, loading/error/empty states, invalid-action rejection, stale-action identity, stable ties, and adapter boundary values.
- `LendPageClient`: 9/10 passed. The remaining `shows a loading skeleton state while pool data is loading` failure is pre-existing on `upstream/main` (verified without this branch's link change).
- Targeted `npx prettier --check` passed for all changed files.
- `npm run typecheck` reports 1,981 pre-existing repository errors and zero errors in files changed by this issue.
