/**
 * Load-shedding middleware — issue #809.
 *
 * Rejects incoming requests with 503 Service Unavailable when the Node.js
 * process is operating beyond capacity, as indicated by either:
 *
 *   • Event-loop lag exceeding LOAD_SHED_LAG_MS (default 100 ms), or
 *   • V8 heap usage exceeding LOAD_SHED_HEAP_PCT of the total heap limit
 *     (default 85 %).
 *
 * Healthcheck and metrics endpoints are exempt from shedding so that
 * orchestrators can still observe the service and route traffic away.
 *
 * A Prometheus counter `requests_shed_total` is incremented on each shed
 * request (labelled by reason: "event_loop_lag" | "heap_usage").
 *
 * Thresholds are configurable via environment variables:
 *   LOAD_SHED_LAG_MS    – event-loop lag threshold in milliseconds (default 100)
 *   LOAD_SHED_HEAP_PCT  – heap usage percentage threshold (default 85)
 */

import type { Request, Response, NextFunction } from 'express';
import { monitorEventLoopDelay } from 'perf_hooks';
import v8 from 'v8';
import client from 'prom-client';
import { metricsRegistry } from './metrics.js';

// ── Prometheus counter ────────────────────────────────────────────────────────

export const requestsShedTotal = new client.Counter({
  name: 'requests_shed_total',
  help: 'Total number of requests rejected by load-shedding middleware.',
  labelNames: ['reason'] as const,
  registers: [metricsRegistry],
});

// ── Event-loop lag sampler ────────────────────────────────────────────────────

/**
 * We use `perf_hooks.monitorEventLoopDelay` (a histogram-based monitor that
 * fires at ~1 Hz) to measure the current P99 event-loop delay without blocking
 * the loop ourselves.  The monitor is started once at module load time and
 * runs for the lifetime of the process.
 */
const ELD_RESOLUTION_MS = 20; // histogram resolution in milliseconds
const eldMonitor = monitorEventLoopDelay({ resolution: ELD_RESOLUTION_MS });
eldMonitor.enable();

// ── Helpers ───────────────────────────────────────────────────────────────────

function getEventLoopLagMs(): number {
  // `mean` is in nanoseconds; convert to milliseconds.
  const meanNs = eldMonitor.mean;
  return meanNs / 1_000_000;
}

function getHeapUsagePct(): number {
  const stats = v8.getHeapStatistics();
  if (stats.heap_size_limit === 0) return 0;
  return (stats.used_heap_size / stats.heap_size_limit) * 100;
}

// ── Exempt paths ──────────────────────────────────────────────────────────────

/**
 * Paths that are always exempt from load-shedding.  Orchestrators (Kubernetes
 * liveness / readiness probes, Prometheus scrape) must always be reachable so
 * the service can be observed and traffic can be rerouted.
 */
const EXEMPT_PREFIXES = ['/health', '/healthz', '/metrics'];

function isExempt(path: string): boolean {
  return EXEMPT_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix + '/'));
}

// ── Middleware factory ────────────────────────────────────────────────────────

export interface LoadSheddingOptions {
  /** Event-loop lag threshold in milliseconds (default: LOAD_SHED_LAG_MS env or 100). */
  lagThresholdMs?: number;
  /** Heap usage percentage threshold 0–100 (default: LOAD_SHED_HEAP_PCT env or 85). */
  heapThresholdPct?: number;
  /** Retry-After header value in seconds (default: 5). */
  retryAfterSecs?: number;
}

/**
 * Returns an Express middleware that sheds load when thresholds are exceeded.
 *
 * Usage — register *after* request-id/trace middleware but *before* any heavy
 * work:
 *
 * ```ts
 * import { loadSheddingMiddleware } from './middleware/loadShedding.js';
 * app.use(loadSheddingMiddleware());
 * ```
 */
export function loadSheddingMiddleware(opts: LoadSheddingOptions = {}) {
  const lagThresholdMs =
    opts.lagThresholdMs ??
    (process.env.LOAD_SHED_LAG_MS ? Number(process.env.LOAD_SHED_LAG_MS) : 100);

  const heapThresholdPct =
    opts.heapThresholdPct ??
    (process.env.LOAD_SHED_HEAP_PCT ? Number(process.env.LOAD_SHED_HEAP_PCT) : 85);

  const retryAfterSecs = opts.retryAfterSecs ?? 5;

  return function loadShedding(req: Request, res: Response, next: NextFunction): void {
    // Always let health / metrics endpoints through.
    if (isExempt(req.path)) {
      return next();
    }

    const lagMs = getEventLoopLagMs();
    const heapPct = getHeapUsagePct();

    if (lagMs > lagThresholdMs) {
      requestsShedTotal.inc({ reason: 'event_loop_lag' });
      res.setHeader('Retry-After', String(retryAfterSecs));
      res.status(503).json({
        error: 'Service temporarily unavailable — high event-loop lag',
        retryAfter: retryAfterSecs,
      });
      return;
    }

    if (heapPct > heapThresholdPct) {
      requestsShedTotal.inc({ reason: 'heap_usage' });
      res.setHeader('Retry-After', String(retryAfterSecs));
      res.status(503).json({
        error: 'Service temporarily unavailable — high memory pressure',
        retryAfter: retryAfterSecs,
      });
      return;
    }

    next();
  };
}

// ── Exported for testing (allows override in unit tests) ─────────────────────

export { getEventLoopLagMs, getHeapUsagePct };
