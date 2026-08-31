"use client";

import { useEffect, useState } from "react";
import * as Sentry from "@sentry/nextjs";
import { ErrorFallback } from "./ErrorBoundary";
import { showErrorFeedbackDialog } from "../../lib/observability";

interface RouteErrorViewProps {
  error: Error & { digest?: string };
  reset: () => void;
  scope: string;
}

/**
 * Shared recovery UI rendered by every route-segment `error.tsx`.
 *
 * Renders the standard fallback (Retry + Go Home) and reports the error to
 * Sentry tagged with the route segment and pathname so crashes can be traced
 * back to the page the user was on.
 */
export function RouteErrorView({ error, reset, scope }: RouteErrorViewProps) {
  const [eventId, setEventId] = useState<string | undefined>();

  useEffect(() => {
    console.error(`Route error in ${scope}:`, error);
    const id = Sentry.captureException(error, { tags: { scope } });
    setEventId(id);
  }, [error, scope]);

  return (
    <ErrorFallback
      error={error}
      onRetry={reset}
      scope={scope}
      variant="page"
      onReportFeedback={() => void showErrorFeedbackDialog(eventId)}
    />
  );
}
