import * as Sentry from "@sentry/nextjs";

const SENTRY_DSN = process.env.NEXT_PUBLIC_SENTRY_DSN;
const NODE_ENV = process.env.NODE_ENV || "development";

const ENVIRONMENT_MAP: Record<string, string> = {
  production: "production",
  staging: "staging",
  development: "development",
  test: "test",
};

/**
 * Errors that are pure noise: browser-extension crashes, benign framework
 * races, and network blips the user already sees surfaced in the UI. Dropping
 * them keeps the signal-to-noise ratio (and quota) sane. See
 * docs/frontend/error-tracking.md.
 */
const IGNORE_ERROR_PATTERNS: RegExp[] = [
  /ResizeObserver loop (limit exceeded|completed with undelivered notifications)/i,
  /Non-Error promise rejection captured/i,
  /Failed to fetch|NetworkError when attempting to fetch resource|Load failed/i,
  /AbortError|The operation was aborted/i,
  /can't redefine non-configurable property/i,
  /Extension context invalidated/i,
  /Freighter is not installed/i,
];

const IGNORE_URL_PATTERNS: RegExp[] = [
  /extensions\//i,
  /^chrome(-extension)?:\/\//i,
  /^moz-extension:\/\//i,
  /^safari-extension:\/\//i,
];

function isNoise(event: Sentry.ErrorEvent): boolean {
  const values = event.exception?.values ?? [];
  for (const value of values) {
    const message = `${value.type ?? ""}: ${value.value ?? ""}`;
    if (IGNORE_ERROR_PATTERNS.some((pattern) => pattern.test(message))) {
      return true;
    }
    const frames = value.stacktrace?.frames ?? [];
    if (frames.some((frame) => IGNORE_URL_PATTERNS.some((p) => p.test(frame.filename ?? "")))) {
      return true;
    }
  }
  return false;
}

if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: ENVIRONMENT_MAP[NODE_ENV] ?? NODE_ENV,
    // Capture a sample of traces for performance monitoring
    tracesSampleRate: NODE_ENV === "production" ? 0.2 : 1.0,
    // Session Replay:
    //  - always attach a replay when an error is captured (100% of errors,
    //    well above the "50% of errors" target);
    //  - sample a small % of *all* sessions in production for baseline context.
    replaysOnErrorSampleRate: 1.0,
    replaysSessionSampleRate: NODE_ENV === "production" ? 0.1 : 0,
    // Tag every event with the environment + release so replays are filterable.
    release: process.env.NEXT_PUBLIC_SENTRY_RELEASE,
    initialScope: {
      tags: { "app.area": "frontend" },
    },
    integrations: [
      Sentry.replayIntegration({
        // --- PII scrubbing: nothing legible is recorded ---
        maskAllText: true,
        maskAllInputs: true,
        blockAllMedia: true,
        // Do not record request/response bodies or headers for any URL.
        networkDetailAllowUrls: [],
        networkCaptureBodies: false,
      }),
      // In-app "something went wrong — tell us what happened" widget. It is
      // hidden by default and opened programmatically from the error UI
      // (see lib/observability.ts -> showErrorFeedbackDialog).
      Sentry.feedbackIntegration({
        autoInject: false,
        showBranding: false,
        colorScheme: "system",
        enableScreenshot: false,
      }),
    ],
    /**
     * Runs for every error before it leaves the browser:
     *  1. drop known noise,
     *  2. strip anything that looks like PII from the URL query string.
     */
    beforeSend(event) {
      if (isNoise(event)) {
        return null;
      }
      if (event.request?.url) {
        try {
          const url = new URL(event.request.url);
          for (const key of ["token", "email", "wallet", "address", "code", "secret"]) {
            if (url.searchParams.has(key)) {
              url.searchParams.set(key, "[redacted]");
            }
          }
          event.request.url = url.toString();
        } catch {
          // non-URL string — leave as-is
        }
      }
      return event;
    },
    enabled: NODE_ENV !== "test",
  });
}
