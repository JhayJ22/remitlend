"use client";

/**
 * components/global_ui/DegradedServiceBanner.tsx
 *
 * Renders a sticky banner at the top of the page when the service is in a
 * degraded state (#349). Reads status from ServiceStatusProvider.
 *
 * - "unknown" (loading): banner is hidden.
 * - "healthy":           banner is hidden.
 * - "degraded":          banner is shown with a contextual message.
 *
 * Accessibility: role="alert" + aria-live="assertive" so screen readers
 * announce the banner as soon as it appears.
 */

import { AlertTriangle, RefreshCw, WifiOff } from "lucide-react";
import { useServiceStatus } from "../providers/ServiceStatusProvider";

export function DegradedServiceBanner() {
  const { health, backendOk, contractsOk, pauseReason, isLoading, refresh, lastCheckedAt } =
    useServiceStatus();

  // Only render when we have a confirmed degraded state.
  if (isLoading || health !== "degraded") return null;

  const isBackendDown = !backendOk;
  const isContractsPaused = backendOk && !contractsOk;

  const title = isBackendDown ? "Service Disruption" : "Contract Operations Paused";

  const body = isBackendDown
    ? "The RemitLend service is temporarily unreachable. Loan and remittance operations are unavailable. Please check back shortly."
    : pauseReason
      ? pauseReason
      : "Smart contract operations are temporarily paused for maintenance or security reasons. Read-only features remain available.";

  const Icon = isBackendDown ? WifiOff : AlertTriangle;

  return (
    <div
      className="border-b border-amber-200 bg-amber-50 px-4 py-3 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200"
      role="alert"
      aria-live="assertive"
      aria-atomic="true"
    >
      <div className="mx-auto flex max-w-7xl flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex items-start gap-3">
          <Icon className="mt-0.5 h-5 w-5 flex-shrink-0" aria-hidden="true" />
          <div className="flex-1">
            <h3 className="font-semibold">{title}</h3>
            <p className="mt-1 text-sm">{body}</p>
            {isContractsPaused && (
              <p className="mt-1 text-xs opacity-75">
                Lending, repayments, and remittances are temporarily blocked. Your funds are safe.
              </p>
            )}
            {lastCheckedAt && (
              <p className="mt-1 text-xs opacity-60">
                Last checked {lastCheckedAt.toLocaleTimeString()}
              </p>
            )}
          </div>
        </div>

        <button
          type="button"
          onClick={refresh}
          className="flex shrink-0 items-center gap-2 rounded-lg bg-amber-900 px-4 py-2 text-sm font-semibold text-amber-50 transition hover:bg-amber-800 dark:bg-amber-200 dark:text-amber-950 dark:hover:bg-amber-100"
          aria-label="Refresh service status"
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          Refresh
        </button>
      </div>
    </div>
  );
}
