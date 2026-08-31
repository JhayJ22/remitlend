"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { setRouteTag } from "../../lib/observability";

/**
 * Keeps the Sentry `route` tag in sync with the active pathname so every error
 * and session replay is filterable by the screen the user was on.
 *
 * The locale segment is normalised out (`/en/loans` -> `/loans`) so errors
 * aggregate across languages.
 */
export function ObservabilityProvider(): null {
  const pathname = usePathname();

  useEffect(() => {
    const normalised = pathname.replace(/^\/[a-z]{2}(?=\/|$)/, "") || "/";
    setRouteTag(normalised);
  }, [pathname]);

  return null;
}
