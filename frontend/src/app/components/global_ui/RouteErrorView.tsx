"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import * as Sentry from "@sentry/nextjs";
import { ErrorFallback } from "./ErrorBoundary";

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
  const pathname = usePathname();

  useEffect(() => {
    console.error(`Route error in ${scope}:`, error);
    Sentry.withScope((sentryScope) => {
      sentryScope.setTag("error_boundary", "route");
      sentryScope.setTag("route_scope", scope);
      sentryScope.setContext("route", {
        scope,
        pathname,
        digest: error.digest ?? null,
      });
      Sentry.captureException(error);
    });
  }, [error, scope, pathname]);

  return <ErrorFallback error={error} onRetry={reset} scope={scope} variant="page" />;
}
