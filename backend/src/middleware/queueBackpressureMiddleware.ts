/**
 * Queue backpressure admission-control middleware (issue #860).
 *
 * Purpose
 * ───────
 * Gate incoming financial write requests (POST/PUT/PATCH/DELETE on financial
 * API surfaces) against the current Soroban write-queue depth. When the queue
 * is saturated, the middleware returns 503 with a `Retry-After` header rather
 * than silently enqueuing additional work that the replay processor cannot
 * drain fast enough.
 *
 * Supported states
 * ────────────────
 *   NORMAL    (depth < warnThreshold)   → admit; pass-through.
 *   ELEVATED  (warnThreshold ≤ depth)   → admit; add X-Queue-Pressure warning
 *                                          header + degraded flag in body.
 *   PRESSURED (softLimit ≤ depth)       → shed background/webhook classes;
 *                                          financial writes still admitted.
 *   SATURATED (hardLimit ≤ depth)       → reject ALL with 503 + Retry-After.
 *
 * Authorization and consent
 * ─────────────────────────
 * - No authentication check is performed here; that is handled by `requireJwtAuth`.
 * - Only state-mutating HTTP methods (POST/PUT/PATCH/DELETE) are gated.
 * - GET/HEAD requests are always admitted (read-only, never enqueue new work).
 *
 * Financial side-effect guarantees
 * ─────────────────────────────────
 * - A 503 response means the transaction was NOT submitted on-chain and NOT
 *   enqueued. The caller should retry with the same Idempotency-Key after
 *   `Retry-After` seconds.
 * - A 200/202 response after the middleware passes means the write was
 *   either executed on-chain or durably enqueued — never silently dropped.
 *
 * Usage
 * ─────
 * Apply to any router that processes financial mutations:
 *
 *   import { financialQueueBackpressureMiddleware } from '../middleware/queueBackpressureMiddleware.js';
 *   router.post('/request', financialQueueBackpressureMiddleware, requireJwtAuth, ...);
 *
 * Or apply globally to all financial-route prefixes in app.ts:
 *   app.use('/api/v1/loans', financialQueueBackpressureMiddleware);
 *   app.use('/api/v1/pool', financialQueueBackpressureMiddleware);
 */

import type { NextFunction, Request, Response } from 'express';
import {
  checkQueueAdmission,
  readQueueSaturation,
  getLastQueueSaturationSnapshot,
} from '../services/queueBackpressure.js';
import { AppError } from '../errors/AppError.js';
import logger from '../utils/logger.js';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// ── Saturation signal headers ─────────────────────────────────────────────────

/** Set on all write responses when queue depth is elevated or above. */
const HDR_QUEUE_PRESSURE = 'x-queue-pressure';
/** Set on responses when the queue is at or above the soft limit. */
const HDR_QUEUE_SATURATED = 'x-queue-saturated';

// ── Core middleware ───────────────────────────────────────────────────────────

/**
 * Admission-control middleware for financial write routes.
 *
 * Always admits GET/HEAD. For writes:
 *   - Forces a fresh queue-depth read (bypasses the 5-second cache) so the
 *     decision is based on the latest depth, not a stale snapshot.
 *   - Calls `checkQueueAdmission('financial')`.
 *   - On `warn`: passes through, adds X-Queue-Pressure header.
 *   - On `shed`: passes through (financial writes are never shed at soft limit).
 *   - On `reject`: returns 503 with Retry-After and structured error body.
 */
export async function financialQueueBackpressureMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // Read-only requests never add to the write queue.
  if (!WRITE_METHODS.has(req.method)) {
    next();
    return;
  }

  try {
    // Force a fresh depth read before every financial write so the decision
    // is never based on a snapshot that is seconds old.
    await readQueueSaturation(true);

    const admission = checkQueueAdmission('financial');

    if (admission.decision === 'reject') {
      logger.warn('[queue-backpressure] Financial write rejected: queue saturated', {
        sorobanQueueDepth: admission.sorobanQueueDepth,
        webhookQueueDepth: admission.webhookQueueDepth,
        saturationRatio: admission.saturationRatio,
        path: req.path,
        method: req.method,
      });

      res.setHeader('Retry-After', String(admission.retryAfterSeconds));
      res.setHeader(HDR_QUEUE_SATURATED, 'true');

      next(
        AppError.serviceUnavailable(
          `The service is temporarily unable to accept new financial write requests. ` +
            `The on-chain write queue is saturated (${admission.sorobanQueueDepth} pending writes). ` +
            `Retry after ${admission.retryAfterSeconds}s using the same Idempotency-Key.`,
        ),
      );
      return;
    }

    if (admission.decision === 'warn') {
      res.setHeader(HDR_QUEUE_PRESSURE, 'elevated');
      logger.info('[queue-backpressure] Financial write admitted with elevated queue pressure', {
        sorobanQueueDepth: admission.sorobanQueueDepth,
        saturationRatio: admission.saturationRatio,
      });
    }
  } catch (err) {
    // Fail-open: a backpressure read error must never block a financial write.
    logger.warn('[queue-backpressure] Admission check failed; allowing request through', {
      error: err instanceof Error ? err.message : String(err),
      path: req.path,
    });
  }

  next();
}

// ── Background-job admission helper ──────────────────────────────────────────

/**
 * Check whether a background job (default-checker, score-reconciler) should
 * run its current tick, given the live queue saturation state.
 *
 * Uses the **cached** snapshot (no DB round-trip). The periodic backpressure
 * refresh loop keeps this fresh enough for background decisions.
 *
 * Returns:
 *   `{ run: true }` — job should proceed normally.
 *   `{ run: false, reason: string }` — job should skip this tick.
 *
 * Usage in a scheduler:
 *   const gate = shouldBackgroundJobRun('background');
 *   if (!gate.run) { logger.warn(gate.reason); return; }
 */
export function shouldBackgroundJobRun(jobClass: 'background' | 'webhook'): {
  run: boolean;
  reason: string;
} {
  const admission = checkQueueAdmission(jobClass);

  if (admission.decision === 'shed' || admission.decision === 'reject') {
    return { run: false, reason: admission.reason };
  }

  return { run: true, reason: 'Queue capacity within acceptable range' };
}

// ── Saturation signal reader for health/status endpoints ─────────────────────

/**
 * Returns the current queue saturation state as a plain object suitable for
 * embedding in health-check and `/ready` responses.
 *
 * Uses the cached snapshot — no DB I/O.
 */
export function getQueueSaturationForStatus(): {
  sorobanWriteQueueDepth: number;
  webhookRetryQueueDepth: number;
  overallSaturationRatio: number;
  degraded: boolean;
  pressured: boolean;
  saturated: boolean;
} {
  const snap = getLastQueueSaturationSnapshot();
  return {
    sorobanWriteQueueDepth: snap.sorobanWriteQueueDepth,
    webhookRetryQueueDepth: snap.webhookRetryQueueDepth,
    overallSaturationRatio: snap.overallSaturationRatio,
    degraded: snap.degraded,
    pressured: snap.pressured,
    saturated: snap.saturated,
  };
}
