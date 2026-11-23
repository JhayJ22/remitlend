# Financial translation review workflow

Issue #839 defines an auditable workflow for money and loan terminology. The English message catalog remains the authoritative source; localizations, glossary entries, and reviewer approvals are versioned next to it and enforced in CI.

## Source-of-truth files

| File                          | Purpose                                                                                                                             |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `messages/en.json`            | Authoritative source strings.                                                                                                       |
| `i18n/financial-strings.json` | Manifest of critical money/loan strings: key, category, source text, translator context, glossary bindings, placeholders, and unit. |
| `i18n/glossary.json`          | Approved term definitions and per-locale renderings, including `doNotTranslate` terms such as `APY`.                                |
| `i18n/review-state.json`      | Latest approval per locale/key, bound to a source fingerprint, reviewer identity, role, and timestamp.                              |

The source fingerprint is an 8-character FNV-1a hash of `{source, context, placeholders, glossaryTermIds}`. It is a change detector for versioned data, not a security token.

## Supported states

- `pending`: no approval has been recorded for this locale/key.
- `approved`: a reviewer approved the exact source fingerprint currently in the manifest.
- `rejected`: a reviewer requested changes; the string blocks release until re-approved.

Only the latest decision per locale/key is effective. Approving an already-approved fingerprint is idempotent and does not rewrite the file. Rejecting and re-approving replace the prior decision in one atomic file write.

## Input constraints

- Critical keys must exist in the manifest and in every non-source locale catalog.
- Placeholders in a translation must match the manifest exactly (same names, no extras).
- Glossary IDs referenced by a manifest entry must exist.
- The source catalog must still contain the exact source text recorded in the manifest.
- A locale that renders a critical string identically to the source needs either a `doNotTranslate` glossary exemption for every referenced term or a current approval. This is the inconsistent-fallback check.
- Review requests require `key`, `locale`, `action` (`approve` or `reject`), and optionally `expectedSourceHash`.

## Authorization and consent

Review is restricted to the `admin` role. The browser BFF route validates the bearer token against `GET /auth/verify`, requires `role: admin`, and derives the reviewer identity from the session `publicKey`. A missing reviewer identity is rejected. No financial side effect occurs before authorization succeeds.

## API contract

`POST /api/i18n/reviews`

```json
{
  "key": "LoanCard.totalOwed",
  "locale": "es",
  "action": "approve",
  "expectedSourceHash": "1a2b3c4d"
}
```

Responses:

- `200` with `{ approval, changed, reviewState }` on success.
- `400` for unknown key/locale, source locale, missing reviewer, or invalid action.
- `401` without a bearer token; `403` for non-admin sessions; `409` for a stale `expectedSourceHash`.
- `500` when session validation or review persistence fails.

The route writes `i18n/review-state.json` via a temporary file and atomic rename. It does not touch message catalogs or glossary data.

## Failure behavior

The release gate blocks when any critical string is missing, empty, unapproved, bound to a stale source fingerprint, has mismatched placeholders, references an unknown glossary term, has drifted source text, or falls back to source without an exemption/approval. Findings are printed with `code`, `locale`, and `key`. No translation is silently substituted and no catalog is mutated by the gate.

## Compatibility and migration

- No public API schema, database column, or stored financial value changes. The new endpoint is internal to the frontend BFF.
- Adding a critical string requires: manifest entry, glossary bindings, translations in all locales, and approvals for each locale. The gate fails until all are present.
- Editing source text, context, placeholders, or glossary bindings invalidates prior approvals; reviewers must approve the new fingerprint.
- Existing deployments use the committed `review-state.json`. Serverless deployments with read-only filesystems should point `reviewStore` at a persistent store; the decision logic and API contract remain unchanged.

## Validation evidence

From `frontend/`:

```bash
npm run i18n:check
npm run test:translation-review
npm run typecheck
```

`i18n:check` runs the existing key-parity check followed by `i18n:financial-check`, so CI blocks release on financial translation regressions. `npm run lint` checks Prettier formatting for this documentation and all new source files.
