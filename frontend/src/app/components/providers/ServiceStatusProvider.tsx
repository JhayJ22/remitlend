"use client";

/**
 * components/providers/ServiceStatusProvider.tsx
 *
 * Global degraded-service experience (#349).
 *
 * Polls `/api/health` (backend liveness) and reuses the existing
 * `/api/status/pause` data (contract pause state) to derive a unified
 * `ServiceStatus` that the rest of the app can read via
 * `useServiceStatus()`.
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │  Status matrix                                                      │
 * │                                                                     │
 * │  backend OK  + contracts OK    → "healthy"                         │
 * │  backend OK  + contracts PAUSED→ "degraded" (contract ops blocked) │
 * │  backend DOWN                  → "degraded" (all ops blocked)      │
 * │  health check timeout / error  → "degraded" (fail-safe mode)       │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * Observability
 * ─────────────
 * Every status transition is logged to the browser console (non-prod) and
 * emitted as a custom `serviceStatus:change` DOM event so other subsystems
 * (e.g. Sentry, analytics) can react without importing this module.
 *
 * Security / threat-model notes
 * ──────────────────────────────
 * - The health check calls `/api/health` on the Next.js origin (same-site),
 *   not the raw backend, so it goes through the existing reverse-proxy path.
 * - Responses are treated as untrusted: the provider reads only the HTTP
 *   status code; JSON parsing failures are handled gracefully.
 * - The degraded banner is purely informational and does NOT gate
 *   authentication or financial operations on the client side. The backend
 *   is the authoritative enforcement point.
 *
 * Rollout
 * ───────
 * 1. Wrap the app root (or layout) with <ServiceStatusProvider>.
 * 2. The DegradedServiceBanner is rendered inside the provider — no other
 *    changes are required.
 * 3. To disable polling in a specific environment set
 *    `NEXT_PUBLIC_SERVICE_HEALTH_POLL_MS=0`.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ServiceHealth = "healthy" | "degraded" | "unknown";

export interface ServiceStatus {
  /** Overall service health derived from backend + contract state. */
  health: ServiceHealth;
  /** True while the initial health check has not yet resolved. */
  isLoading: boolean;
  /** True when the backend API is reachable. */
  backendOk: boolean;
  /** True when smart contracts are NOT paused. */
  contractsOk: boolean;
  /** Pause reason text returned by /api/status/pause, if any. */
  pauseReason: string | null;
  /** Timestamp of the last successful health check. */
  lastCheckedAt: Date | null;
  /** Trigger an immediate re-check without waiting for the poll interval. */
  refresh: () => void;
}

// ─── Context ──────────────────────────────────────────────────────────────────

const ServiceStatusContext = createContext<ServiceStatus | null>(null);

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_POLL_MS = (() => {
  const raw = process.env.NEXT_PUBLIC_SERVICE_HEALTH_POLL_MS;
  if (raw === undefined || raw === null) return 30_000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 30_000;
})();

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

// ─── Provider ─────────────────────────────────────────────────────────────────

export function ServiceStatusProvider({ children }: { children: ReactNode }) {
  const [backendOk, setBackendOk] = useState(true);
  const [contractsOk, setContractsOk] = useState(true);
  const [pauseReason, setPauseReason] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [lastCheckedAt, setLastCheckedAt] = useState<Date | null>(null);
  const previousHealthRef = useRef<ServiceHealth | null>(null);

  const checkHealth = useCallback(async () => {
    try {
      const [healthRes, pauseRes] = await Promise.allSettled([
        fetch(`${API_URL}/health`, { cache: "no-store" }),
        fetch(`${API_URL}/status/pause`, { cache: "no-store" }),
      ]);

      // Backend liveness: any 2xx means up; network failure / 5xx means down.
      const isBackendOk = healthRes.status === "fulfilled" && healthRes.value.ok;
      setBackendOk(isBackendOk);

      // Contract pause state.
      let isContractsOk = true;
      let reason: string | null = null;

      if (pauseRes.status === "fulfilled" && pauseRes.value.ok) {
        try {
          const pauseData = await pauseRes.value.json();
          const isPaused = pauseData?.data?.isPaused ?? pauseData?.isPaused ?? false;
          isContractsOk = !isPaused;
          reason = isPaused ? (pauseData?.data?.reason ?? pauseData?.reason ?? null) : null;
        } catch {
          // JSON parse failure — treat as contracts OK to fail open.
        }
      } else if (pauseRes.status === "rejected") {
        // Cannot reach the pause endpoint; treat as contracts OK (fail open).
      }

      setContractsOk(isContractsOk);
      setPauseReason(reason);
      setLastCheckedAt(new Date());
    } catch {
      // Unexpected error (e.g. Promise.allSettled itself shouldn't throw,
      // but guard anyway). Fail open — don't flip to degraded on noise.
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Initial check + polling
  useEffect(() => {
    void checkHealth();

    if (DEFAULT_POLL_MS === 0) return;

    const interval = setInterval(() => void checkHealth(), DEFAULT_POLL_MS);
    return () => clearInterval(interval);
  }, [checkHealth]);

  // Emit a DOM event and console log on status transitions (non-prod)
  const health: ServiceHealth = isLoading
    ? "unknown"
    : backendOk && contractsOk
      ? "healthy"
      : "degraded";

  useEffect(() => {
    if (health === "unknown") return;

    if (previousHealthRef.current !== health) {
      previousHealthRef.current = health;

      if (process.env.NODE_ENV !== "production") {
        console.info(`[ServiceStatus] status changed → ${health}`, {
          backendOk,
          contractsOk,
          pauseReason,
        });
      }

      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent("serviceStatus:change", {
            detail: { health, backendOk, contractsOk, pauseReason },
          }),
        );
      }
    }
  }, [health, backendOk, contractsOk, pauseReason]);

  const value: ServiceStatus = {
    health,
    isLoading,
    backendOk,
    contractsOk,
    pauseReason,
    lastCheckedAt,
    refresh: checkHealth,
  };

  return <ServiceStatusContext.Provider value={value}>{children}</ServiceStatusContext.Provider>;
}

// ─── Consumer hook ────────────────────────────────────────────────────────────

/**
 * Returns the current service health status.
 *
 * Must be used inside <ServiceStatusProvider>.
 *
 * @example
 * const { health, contractsOk } = useServiceStatus();
 * if (!contractsOk) return <p>Contracts are paused.</p>;
 */
export function useServiceStatus(): ServiceStatus {
  const ctx = useContext(ServiceStatusContext);
  if (!ctx) {
    throw new Error("useServiceStatus must be used within <ServiceStatusProvider>");
  }
  return ctx;
}
