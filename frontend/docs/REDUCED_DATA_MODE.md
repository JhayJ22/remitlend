# Reduced-Data Mode for Sensitive Screens

**Issue:** #838  
**Status:** Implemented  
**Affects:** Frontend display layer only — wallet addresses, balances, currency amounts, credit scores, and counts on sensitive screens  

---

## Overview

Reduced-data mode lets users mask account identifiers and balances on demand. When enabled, sensitive values are replaced with fixed-width masks so they are absent from copied text, screenshots, and accessible names. The preference is stored locally on the user's device and does not modify the authoritative source of truth (database or blockchain).

---

## Supported States

| State | Description |
|---|---|
| `full` | Real values are shown in full (default). `data-privacy="full"` on `<html>`. |
| `reduced` | Sensitive values are masked. `data-privacy="reduced"` on `<html>`. The user can temporarily reveal individual values via the eye toggle. |

The state is stored in `localStorage` under the key `remitlend-privacy` and reflected to `document.documentElement.dataset.privacy` before the first paint via an inline `<head>` script (anti-FOUC).

---

## What Gets Masked

| Data type | Mask | Example |
|---|---|---|
| Wallet address (full) | `G••••••••` | `GA1234...` → `G••••••••` |
| Wallet address (truncated) | `G••••••••` | `GA1234...5678` → `G••••••••` |
| Currency / balance | `••••••••` | `$1,234.56` → `••••••••` |
| Percentage | `••••••••` | `8.00%` → `••••••••` |
| Credit score | `•••` | `750` → `•••` |
| Count (active loans, etc.) | `•••` | `42` → `•••` |
| Sensitive string (remittance) | `••••••••` | `John Doe` → `••••••••` |

All masks are **fixed-width** so they do not leak the length of the underlying value.

---

## How Hidden Values Are Protected

### Copied text
- Copy buttons on masked values are **disabled** (`disabled` attribute, `tabIndex={-1}`).
- The `aria-label` on the copy button reads "Copy {label} disabled (hidden)" so screen readers announce the disabled state.
- After the user reveals a value (eye toggle), the copy button becomes enabled and copies the real value.

### Screenshots
- When masked, the rendered text is the mask string, not the real value. A screenshot captures only the mask.
- `user-select: none` CSS is applied to masked elements so drag-to-select cannot highlight the real value.
- The real value is never inserted into the DOM text content when masked — only the mask string is rendered.

### Accessible names
- When masked, `aria-label` is set to `"{label} hidden"` (e.g., "Account balance hidden"), not the real value.
- The `title` attribute is also set to `"{label} hidden"`.
- Screen readers announce the masked state, not the real value.

---

## User Controls

### Settings → Privacy section
A new "Privacy" section in the settings page provides a `Toggle` switch (role="switch", aria-checked) to enable/disable reduced-data mode. The section includes:
- A description of what the mode does
- A list of what gets masked
- A note that the preference is local to this device

### Per-value reveal toggle
Each `MaskedValue` component includes an eye icon button (Eye/EyeOff) that lets the user temporarily reveal the real value. Clicking again re-masks it. This follows the existing progressive-disclosure pattern from `useRemittances` (reveal/conceal/toggle).

---

## Persistence

The preference is stored via Zustand's `persist` middleware to `localStorage`:

```json
{
  "state": { "reducedDataMode": true },
  "version": 0
}
```

The store key is `remitlend-privacy`. The `partialize` option ensures only `reducedDataMode` is persisted (not the `hydrated` flag). On rehydration, `onRehydrateStorage` syncs the DOM data attribute.

### Anti-FOUC inline script
An inline `<script>` in `layout.tsx` reads the preference from localStorage before the first paint and sets `document.documentElement.dataset.privacy` to `"reduced"` or `"full"`. This prevents a flash of real values before React hydrates.

---

## Architecture

### Privacy store (`usePrivacyStore.ts`)
- Zustand store with `persist` middleware (mirrors `useGamificationStore`)
- State: `reducedDataMode: boolean`, `hydrated: boolean`
- Actions: `setReducedDataMode`, `toggleReducedDataMode`, `setHydrated`
- Selectors: `selectReducedDataMode`, `selectPrivacyHydrated`
- `readReducedDataModeFromStorage()` — reads localStorage without initialising the store (for the inline script)

### Privacy-aware formatting (`utils/privacyFormat.ts`)
- `formatCurrency(value, masked)` — USD Intl.NumberFormat or mask
- `formatPercent(value, masked)` — `(v*100).toFixed(2)+"%"` or mask
- `formatBalance(value, masked)` — `toLocaleString` or mask
- `formatAddress(address, masked)` — full address or `G••••••••`
- `truncateAddress(address, masked)` — truncated or masked
- `formatScore(score, masked)` — number or `•••`
- `formatCount(count, masked)` — number or `•••`
- `resolveMaskedValue(value, masked)` — generic string masking

### MaskedValue component (`ui/MaskedValue.tsx`)
- `MaskedValue` — renders a masked/revealed value with eye toggle and copy button
- `MaskedValueText` — lighter inline variant without toggle/copy (for compact stat cards)

### Toggle component (`ui/Toggle.tsx`)
- Extracted from the settings page's inline component for reuse
- `role="switch"`, `aria-checked`, `aria-label`

### Settings integration (`settings/page.tsx`)
- New "Privacy" section with the Toggle and explanatory text
- Added to the SECTIONS array and the switch statement

### Layout integration (`layout.tsx`)
- Anti-FOUC inline script for `data-privacy` attribute
- Import of `PRIVACY_STORAGE_KEY` from the privacy store

### i18n (`messages/{en,es,tl}.json`)
- New `Privacy` namespace with labels for the settings section and masked-state descriptions

---

## Input Constraints

| Constraint | Rule |
|---|---|
| `reducedDataMode` | Boolean (`true`/`false`); default `false` (fail-open for display) |
| localStorage parse error | Falls back to `false` (show real data) |
| Missing localStorage key | Falls back to `false` |
| Empty/null values | `formatAddress`/`formatScore`/`formatCount` return `"—"`, not the mask |

---

## Failure Behavior

| Failure | Behavior |
|---|---|
| localStorage unavailable | Store defaults to `reducedDataMode: false` (real data shown) |
| localStorage parse error | `readReducedDataModeFromStorage()` catches and returns `false` |
| Store not yet hydrated | Components read `data-privacy` attribute set by the inline script; the `MaskedValue` component's `globalMask` prop controls masking, not the store directly |
| User reveals a value then navigates away | The local reveal state is component-scoped (useState); it resets on unmount. The global preference persists. |

---

## Compatibility and Migration

- **No schema changes** — this is a purely frontend, display-layer feature.
- **No API changes** — the backend and blockchain are never modified.
- **No breaking changes** — the default is `reducedDataMode: false`, so existing behavior is unchanged.
- **localStorage key** — `remitlend-privacy` is new; no existing key conflicts.
- **DOM attribute** — `data-privacy` is new; CSS can target it but no existing CSS depends on it.

---

## Validation Evidence

Run the following to reproduce all test cases:

```bash
# Privacy-aware formatting tests
cd frontend && npm test -- --testPathPattern="privacyFormat"

# MaskedValue component tests
cd frontend && npm test -- --testPathPattern="MaskedValue"
```

Expected: all tests pass. The test suites cover:
- Success path: masked=false shows real value, masked=true shows mask
- Mask does not leak the real value in text, aria-label, or title
- Reveal toggle works (reveal → real value shown, conceal → mask shown)
- Copy button disabled when masked, enabled when revealed
- user-select: none applied when masked (screenshot protection)
- Boundary: empty/null/undefined values return "—"
- Mask width is constant regardless of input length (no length leak)
- MaskedValueText lighter variant masks inline
