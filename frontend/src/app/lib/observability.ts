"use client";

/**
 * lib/observability.ts
 *
 * Thin helpers around `@sentry/nextjs` so the rest of the app sets consistent
 * context on errors and session replays without importing Sentry everywhere.
 *
 * See docs/frontend/error-tracking.md.
 */

import * as Sentry from "@sentry/nextjs";

/**
 * Associate the current session (and its replay) with a user. Pass only a
 * stable identifier — never an email, wallet address or other PII, which would
 * end up in replay metadata.
 */
export function setSentryUser(userId: string | null): void {
  if (!userId) {
    Sentry.setUser(null);
    Sentry.setTag("userId", undefined);
    return;
  }
  Sentry.setUser({ id: userId });
  Sentry.setTag("userId", userId);
}

/** Tag subsequent events with the loan currently being viewed / acted on. */
export function setLoanContext(loanId: string | null): void {
  Sentry.setTag("loanId", loanId ?? undefined);
}

/** Tag subsequent events with the active route (called on every navigation). */
export function setRouteTag(route: string): void {
  Sentry.setTag("route", route);
}

/** Drop a breadcrumb for a user-meaningful action (used around mutations). */
export function trackAction(message: string, data?: Record<string, unknown>): void {
  Sentry.addBreadcrumb({ category: "action", level: "info", message, data });
}

/**
 * Open the Sentry user-feedback dialog, optionally linked to a specific event.
 * Call this from an error boundary / error page so users can describe what they
 * were doing when it broke.
 */
export async function showErrorFeedbackDialog(eventId?: string): Promise<void> {
  const feedback = Sentry.getFeedback();
  if (!feedback) return;
  const form = await feedback.createForm({
    ...(eventId ? { associatedEventId: eventId } : {}),
  });
  form.appendToDom();
  form.open();
}
