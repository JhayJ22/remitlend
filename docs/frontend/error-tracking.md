# Error tracking & session replay (Sentry)

Client config: `frontend/sentry.client.config.ts`.
Helpers: `src/app/lib/observability.ts`.

## Session replay

| Setting | Value | Notes |
| --- | --- | --- |
| `replaysOnErrorSampleRate` | `1.0` | A replay is attached to **every** captured error — comfortably above the "50% of errors" target. |
| `replaysSessionSampleRate` | `0.1` in prod, `0` elsewhere | Baseline sampling of error-free sessions for context. |

### PII scrubbing — nothing legible is recorded

- `maskAllText: true` — all text nodes are masked.
- `maskAllInputs: true` — all form inputs are masked.
- `blockAllMedia: true` — images / video / canvas are blocked.
- `networkDetailAllowUrls: []` + `networkCaptureBodies: false` — no request or
  response bodies/headers are captured.
- `beforeSend` redacts `token`, `email`, `wallet`, `address`, `code`, `secret`
  query params from the event URL.

If a specific element must stay visible in replays, add `data-sentry-unmask`;
to hard-block one, add `data-sentry-block`. Never unmask anything containing a
name, email, wallet address, balance or amount.

## Custom tags

Set via `observability.ts` so every error and replay is filterable:

| Tag | Where it's set |
| --- | --- |
| `route` | `ObservabilityProvider` — on every navigation, locale-stripped (`/loans`). |
| `userId` | `setSentryUser(id)` at auth boundary. **Stable id only, never email/wallet.** |
| `loanId` | `setLoanContext(id)` on loan detail / repay / extension screens. |
| `app.area`, `error_boundary`, `scope` | set automatically by init / `ErrorBoundary` / `RouteErrorView`. |

Use `trackAction(message, data)` to leave a breadcrumb around a mutation.

## Noise filtering (`beforeSend`)

Dropped before leaving the browser:

- `ResizeObserver loop …`, `Non-Error promise rejection captured`
- transient network errors already surfaced in the UI (`Failed to fetch`,
  `Load failed`, `AbortError`)
- anything originating from a browser-extension URL
  (`chrome-extension://`, `moz-extension://`, `extensions/…`)
- `Freighter is not installed` (handled by the wallet UI)

Add new patterns to `IGNORE_ERROR_PATTERNS` / `IGNORE_URL_PATTERNS`.

## User feedback widget

`feedbackIntegration({ autoInject: false })` — the button is not injected
globally. The full-page error view (`RouteErrorView` → `ErrorFallback`) shows a
**"Tell us what happened"** button that calls `showErrorFeedbackDialog(eventId)`,
linking the user's description to the captured event.
