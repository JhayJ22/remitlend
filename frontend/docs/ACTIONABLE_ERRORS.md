# Actionable localized errors

Issue #840 defines a single, auditable mapping from stable backend error codes to localized guidance and a safe recovery action.

## Source of truth

- Backend contract: `backend/src/errors/errorCodes.ts` (`ErrorCode` enum) plus the structured error payload emitted by `backend/src/middleware/errorHandler.ts` (`error.code`, optional `error.requestId`/`referenceId`).
- Presentation contract: `frontend/src/lib/errors.ts`. This is the canonical mapping from code → guidance category → severity, retryability, and action.
- Localized copy: the `Errors` namespace in `frontend/messages/{en,es,tl}.json`. Each guidance category has a title, message, and guidance text per locale; action labels and the reference label are localized once.
- UI: `frontend/src/app/components/global_ui/ActionableError.tsx`, used by `RouteErrorView` when a route error carries a stable code.

No value from `message`, `details`, or a stack trace is ever rendered. Raw server text is treated as untrusted diagnostic data.

## Supported states and actions

Each code maps to one guidance category:

| Category                                       | Meaning                                           | Default action            |
| ---------------------------------------------- | ------------------------------------------------- | ------------------------- |
| `invalidAmount`, `invalidInput`, `invalidLoan` | User input must be corrected                      | none                      |
| `invalidCredentials`                           | Wallet/signature/challenge detail needs attention | retry or refresh          |
| `sessionExpired`                               | Re-authentication is required                     | reauthenticate or refresh |
| `accessDenied`                                 | Insufficient permissions                          | contact support           |
| `notFound`, `loanState`, `duplicateRequest`    | State must be rechecked                           | refresh                   |
| `conflict`, `insufficientFunds`                | State changed; refresh before deciding            | refresh                   |
| `rateLimited`                                  | Backoff before retrying                           | retry                     |
| `unavailable`, `blockchain`, `internal`        | Transient dependency or network failure           | retry / contact support   |
| `fallback`                                     | Unknown code or malformed payload                 | none                      |

Retry is never implicit. Only presentations marked `retryable` render a recovery button, and `nextRetryDelayMs` bounds backoff. Duplicate requests and non-retryable financial-state errors never auto-retry, so no partial money movement can be caused by error handling.

## Input constraints

- Codes are accepted only when they match `^[A-Z][A-Z0-9_]*$` and are at most 64 characters.
- Reference IDs are accepted only when they match `^[A-Za-z0-9][A-Za-z0-9._:-]*$` and are at most 64 characters. Paths, markup, and values with spaces are rejected.
- Codes and reference IDs are rendered inside `<code>` elements verbatim. They are never passed to the translator.
- Unknown but well-formed codes keep their identifier and receive `fallback` guidance; malformed codes receive the anonymous fallback.

## Authorization and failure behavior

Error presentation is read-only and available to every user; it requires no additional consent and performs no request. `RouteErrorView` still reports the underlying error to Sentry for operators; the UI copy is derived only from the safe presentation object. If localization data is missing, the release gate fails before deployment rather than showing a raw key at runtime.

## API, event, persistence, and UI consistency

- API: stable `error.code` values and technical reference IDs are preserved end-to-end. No error-message schema change is required on the backend.
- Events: no new event is emitted. The reference ID already present on the request is the correlation key between UI, logs, and support.
- Persistence: no stored financial or user record changes. Reference IDs are display-only and are not written to a new store.
- UI: one `ErrorPresentation` feeds both the localized copy and the rendered identifiers, so all route error views show the same code/reference for the same payload.

## Compatibility and migration

- This change is additive for the API: no public status code, field name, or money unit changes.
- Existing payloads using `error.code` or legacy top-level `code` continue to work.
- Adding a backend code requires a presentation entry and localized guidance in all locales; `npm run i18n:check` blocks release otherwise.
- Renaming a code is a breaking change for the mapping and must be accompanied by an updated entry before release.

## Validation evidence

From `frontend/`:

```bash
npm run i18n:check
npm run test:actionable-errors
npm run typecheck
```

`i18n:check` runs key parity plus `i18n:error-check`, which verifies that every backend enum code has a presentation mapping and that every guidance category/action has non-empty copy in all locales. The tests cover successful mapping, legacy/structured payloads, unsafe input rejection, reference-ID preservation, unknown codes, retry bounds, localization safety, and the rendered UI behavior.
