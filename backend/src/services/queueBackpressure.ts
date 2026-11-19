/**
 * Controlled backpressure for provider and indexing queues (issue #860).
 *
 * Problem
 * ───────
 * Four background job classes share the same Soroban RPC and PostgreSQL
 * connections: the Soroban write replay queue, the webhook retry queue, the
 * default-checker batch queue, and the score-reconciliation batch queue.
 * When any of these queues saturates — because the RPC is slow, a provider
 * is throttling, or the indexer is behind — new incoming financial state
 * changes can still be accepted by the API and silently join the same
 * back-logged queue with no signal to the caller.
 *
 * Solution
 * ────────
 * This module defines:
 *   1. Per-queue capacity limits, priority classes, and shedding policies.
 *   2. A `QueueSaturationSnapshot` that aggregates live saturation signals
 *      from every job class into a single observable value.
 *   3. `checkQueueAdmission(jobClass)` — a pure, synchronous admission test
 *      that callers invoke before enqueuing new work. Returns a typed result
 *      that tells callers whether to admit, shed, or queue with a warning.
 *   4. `readQueueSaturation()` — the async refresh that re-reads all counters
 *      from the data layer. Called on a cadence by the backpressure refresh
 *      loop and by the saturation middleware before every financial write.
 *
 * Design invariants
 * ─────────────────
 * - Financial state changes (loan request, repayment, collateral, pool ops)
 *   are NEVER silently dropped. When the queue is at HARD_LIMIT an explicit
 *   503 with `Retry-After` is returned to the caller.
 * - Below the SOFT_LIMIT, all writes are admitted; a warning is added to the
 *   response when the queue is above WARN_THRESHOLD.
 * - Between SOFT_LIMIT and HARD_LIMIT, non-financial lower-priority job
 *   classes (reconciliation, default-check background scans) are shed first.
 * - Exact money values in payloads are never inspected or modified here; this
 *   module only reads queue depths, never queue contents.
 * - All thresholds are env-overridable with safe production defaults so no
 *   deployment config change is required.
 *
 * Job-class priority (highest → lowest)
 * ──────────────────────────────────────
 *   FINANCIAL    — on-chain financial writes (loan/pool/repay). Never shed.
 *   REPLAY       — Soroban write-replay drain. Shed only above HARD_LIMIT.
 *   WEBHOOK      — Webhook delivery retries. Shed at SOFT_LIMIT.
 *   BACKGROUND   — Default-checker and score-reconciliation scans. Shed first.
 */

import logger from '../utils/logger.js';
import { query } from '../db/connection.js';
import { recordQueueSaturation } from '../middleware/metrics.js';

// ── Types ─────────────────────────────────────────────────────────────────────

/** Job classes ordered by priority (descending). */
export type QueueJobClass = 'financial' | 'replay' | 'webhook' | 'background';

/** Admission decision returned by checkQueueAdmission(). */
export type AdmissionDecision = 'admit' | 'warn' | 'shed' | 'reject';

/** Result of a single admission check. */
export interface AdmissionResult {
  /** Whether the caller should proceed, proceed with warning, shed, or reject. */
  decision: AdmissionDecision;
  /** Saturation level (0–1) of the most saturated queue. */
  saturationRatio: number;
  /** Current depth of the Soroban write queue. */
  sorobanQueueDepth: number;
  /** Current depth of the webhook retry queue. */
  webhookQueueDepth: number;
  /** Human-readable explanation of the decision (safe to log; no secret values). */
  reason: string;
  /**
   * Seconds until the caller may retry (non-zero only when decision='reject').
   * Derived from the Soroban write-replay interval so callers know when the
   * queue is likely to have drained enough to accept new work.
   */
  retryAfterSeconds: number;
}

/** Point-in-time snapshot of all queue depths and saturation signals. */
export interface QueueSaturationSnapshot {
  /** Timestamp (Unix ms) when this snapshot was taken. */
  capturedAt: number;
  /** Pending Soroban writes (from soroban_write_queue WHERE status='pending'). */
  sorobanWriteQueueDepth: number;
  /** Webhook deliveries awaiting retry (delivered_at IS NULL AND next_retry_at IS NOT NULL). */
  webhookRetryQueueDepth: number;
  /** Saturation ratio for the Soroban write queue (0–1, capped at 1). */
  sorobanSaturationRatio: number;
  /** Saturation ratio for the webhook retry queue (0–1, capped at 1). */
  webhookSaturationRatio: number;
  /** Max of the two saturation ratios. */
  overallSaturationRatio: number;
  /** True when any queue is above WARN_THRESHOLD. */
  degraded: boolean;
  /** True when any queue is at or above SOFT_LIMIT. */
  pressured: boolean;
  /** True when any queue is at or above HARD_LIMIT. */
  saturated: boolean;
}

// ── Capacity configuration ────────────────────────────────────────────────────

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Returns the configured capacity parameters for the Soroban write queue.
 *
 * | Parameter       | Env var                             | Default |
 * |-----------------|-------------------------------------|---------|
 * | Warn threshold  | SOROBAN_QUEUE_WARN_THRESHOLD        | 50      |
 * | Soft limit      | SOROBAN_QUEUE_SOFT_LIMIT            | 200     |
 * | Hard limit      | SOROBAN_QUEUE_HARD_LIMIT            | 500     |
 *
 * The hard limit is the maximum number of pending rows the queue may contain
 * before new FINANCIAL class writes are rejected with 503. It MUST be
 * set high enough to accommodate any burst of writes that can arrive during
 * a full RPC outage (typically: `maxLoansPerRun × batchSize` = 500 × 25 = at
 * most 20 outstanding writes per run, with up to 3 concurrent batch
 * submissions = 60 max at any single moment during a default-check run).
 * The 500-row default leaves a 8× headroom.
 */
export function getSorobanQueueCapacity(): {
  warnThreshold: number;
  softLimit: number;
  hardLimit: number;
} {
  const warnThreshold = readPositiveInt('SOROBAN_QUEUE_WARN_THRESHOLD', 50);
  const softLimit = readPositiveInt('SOROBAN_QUEUE_SOFT_LIMIT', 200);
  const hardLimit = readPositiveInt('SOROBAN_QUEUE_HARD_LIMIT', 500);

  return { warnThreshold, softLimit, hardLimit };
}

/**
 * Returns the configured capacity parameters for the webhook retry queue.
 *
 * | Parameter       | Env var                             | Default |
 * |-----------------|-------------------------------------|---------|
 * | Warn threshold  | WEBHOOK_QUEUE_WARN_THRESHOLD        | 100     |
 * | Soft limit      | WEBHOOK_QUEUE_SOFT_LIMIT            | 500     |
 * | Hard limit      | WEBHOOK_QUEUE_HARD_LIMIT            | 2000    |
 */
export function getWebhookQueueCapacity(): {
  warnThreshold: number;
  softLimit: number;
  hardLimit: number;
} {
  const warnThreshold = readPositiveInt('WEBHOOK_QUEUE_WARN_THRESHOLD', 100);
  const softLimit = readPositiveInt('WEBHOOK_QUEUE_SOFT_LIMIT', 500);
  const hardLimit = readPositiveInt('WEBHOOK_QUEUE_HARD_LIMIT', 2000);

  return { warnThreshold, softLimit, hardLimit };
}

// ── Shared saturation snapshot (cached, updated by the refresh loop) ──────────

let _lastSnapshot: QueueSaturationSnapshot = {
  capturedAt: 0,
  sorobanWriteQueueDepth: 0,
  webhookRetryQueueDepth: 0,
  sorobanSaturationRatio: 0,
  webhookSaturationRatio: 0,
  overallSaturationRatio: 0,
  degraded: false,
  pressured: false,
  saturated: false,
};

/** How long (ms) a snapshot may be served from cache before a fresh read. */
const SNAPSHOT_TTL_MS = 5_000;

/**
 * Returns the most recently refreshed saturation snapshot without hitting
 * the database. Safe to call in hot paths.
 */
export function getLastQueueSaturationSnapshot(): QueueSaturationSnapshot {
  return { ..._lastSnapshot };
}

// ── Queue depth reads ─────────────────────────────────────────────────────────

/**
 * Read the current Soroban write queue depth from PostgreSQL.
 * Returns 0 on any DB error (fail-open: a DB failure must not block writes).
 */
export async function readSorobanWriteQueueDepth(): Promise<number> {
  try {
    const result = await query(
      `SELECT COUNT(*)::int AS count
       FROM soroban_write_queue
       WHERE status = 'pending'`,
      [],
    );
    return Number((result.rows[0] as { count: number } | undefined)?.count ?? 0);
  } catch (err) {
    logger.warn('[queue-backpressure] Failed to read soroban_write_queue depth', {
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

/**
 * Read the current webhook retry queue depth from PostgreSQL.
 * Returns 0 on any DB error.
 */
export async function readWebhookRetryQueueDepth(): Promise<number> {
  try {
    const result = await query(
      `SELECT COUNT(*)::int AS count
       FROM webhook_deliveries
       WHERE delivered_at IS NULL
         AND next_retry_at IS NOT NULL
         AND dead_lettered_at IS NULL`,
      [],
    );
    return Number((result.rows[0] as { count: number } | undefined)?.count ?? 0);
  } catch (err) {
    logger.warn('[queue-backpressure] Failed to read webhook_deliveries retry depth', {
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

// ── Saturation snapshot builder ───────────────────────────────────────────────

function buildSnapshot(
  sorobanDepth: number,
  webhookDepth: number,
): QueueSaturationSnapshot {
  const sc = getSorobanQueueCapacity();
  const wc = getWebhookQueueCapacity();

  const sorobanRatio = Math.min(sorobanDepth / sc.hardLimit, 1);
  const webhookRatio = Math.min(webhookDepth / wc.hardLimit, 1);
  const overallRatio = Math.max(sorobanRatio, webhookRatio);

  const degraded =
    sorobanDepth >= sc.warnThreshold || webhookDepth >= wc.warnThreshold;
  const pressured =
    sorobanDepth >= sc.softLimit || webhookDepth >= wc.softLimit;
  const saturated =
    sorobanDepth >= sc.hardLimit || webhookDepth >= wc.hardLimit;

  return {
    capturedAt: Date.now(),
    sorobanWriteQueueDepth: sorobanDepth,
    webhookRetryQueueDepth: webhookDepth,
    sorobanSaturationRatio: sorobanRatio,
    webhookSaturationRatio: webhookRatio,
    overallSaturationRatio: overallRatio,
    degraded,
    pressured,
    saturated,
  };
}

// ── Public refresh function ───────────────────────────────────────────────────

/**
 * Refresh the saturation snapshot by reading live queue depths from the DB.
 *
 * Both reads run in parallel. If either fails it defaults to 0 (fail-open).
 * The updated snapshot is cached for `SNAPSHOT_TTL_MS` and can be read
 * cheaply via `getLastQueueSaturationSnapshot()`.
 *
 * Pass `force = true` to skip the TTL cache (used by admission-control
 * middleware that must always see a fresh value before a financial write).
 */
export async function readQueueSaturation(
  force = false,
): Promise<QueueSaturationSnapshot> {
  const now = Date.now();

  if (!force && now - _lastSnapshot.capturedAt < SNAPSHOT_TTL_MS) {
    return { ..._lastSnapshot };
  }

  const [sorobanDepth, webhookDepth] = await Promise.all([
    readSorobanWriteQueueDepth(),
    readWebhookRetryQueueDepth(),
  ]);

  const snapshot = buildSnapshot(sorobanDepth, webhookDepth);
  _lastSnapshot = snapshot;

  // Push updated depths to Prometheus so the /metrics endpoint stays current.
  recordQueueSaturation(sorobanDepth, webhookDepth, snapshot.overallSaturationRatio);

  if (snapshot.saturated) {
    logger.warn('[queue-backpressure] Queue saturation reached hard limit', {
      sorobanDepth,
      webhookDepth,
      overallRatio: snapshot.overallSaturationRatio,
    });
  } else if (snapshot.pressured) {
    logger.info('[queue-backpressure] Queue approaching soft limit', {
      sorobanDepth,
      webhookDepth,
      overallRatio: snapshot.overallSaturationRatio,
    });
  }

  return snapshot;
}

// ── Admission control ─────────────────────────────────────────────────────────

/**
 * Check whether a new unit of work for `jobClass` should be admitted.
 *
 * Uses the **cached** snapshot (no DB I/O) so it is safe to call in hot
 * paths.  Call `readQueueSaturation(true)` before this function when you
 * need a fresh view (the admission-control middleware does this).
 *
 * Shedding policy by priority:
 *
 *   depth < warnThreshold   → admit all job classes
 *   warnThreshold ≤ depth   → admit + warn for 'financial' and 'replay'
 *   softLimit ≤ depth       → shed 'background' and 'webhook' classes
 *   hardLimit ≤ depth       → reject ALL classes (503 with Retry-After)
 */
export function checkQueueAdmission(jobClass: QueueJobClass): AdmissionResult {
  const snapshot = _lastSnapshot;
  const sc = getSorobanQueueCapacity();

  const sorobanDepth = snapshot.sorobanWriteQueueDepth;
  const retryAfterSeconds = readPositiveInt('SOROBAN_WRITE_REPLAY_INTERVAL_MS', 15_000) / 1_000;

  // Hard limit — reject all classes (never silently drop financial writes).
  if (snapshot.saturated || sorobanDepth >= sc.hardLimit) {
    return {
      decision: 'reject',
      saturationRatio: snapshot.overallSaturationRatio,
      sorobanQueueDepth: sorobanDepth,
      webhookQueueDepth: snapshot.webhookRetryQueueDepth,
      reason: `Queue has reached its hard capacity limit (${sorobanDepth}/${sc.hardLimit} pending Soroban writes). Retry after the queue drains.`,
      retryAfterSeconds,
    };
  }

  // Soft limit — shed lower-priority job classes.
  if (snapshot.pressured || sorobanDepth >= sc.softLimit) {
    if (jobClass === 'background' || jobClass === 'webhook') {
      return {
        decision: 'shed',
        saturationRatio: snapshot.overallSaturationRatio,
        sorobanQueueDepth: sorobanDepth,
        webhookQueueDepth: snapshot.webhookRetryQueueDepth,
        reason: `Queue is under pressure (${sorobanDepth}/${sc.hardLimit} pending Soroban writes). Shedding lower-priority ${jobClass} work to protect financial writes.`,
        retryAfterSeconds: 0,
      };
    }
  }

  // Warn threshold — admit with warning for all classes.
  if (snapshot.degraded || sorobanDepth >= sc.warnThreshold) {
    return {
      decision: 'warn',
      saturationRatio: snapshot.overallSaturationRatio,
      sorobanQueueDepth: sorobanDepth,
      webhookQueueDepth: snapshot.webhookRetryQueueDepth,
      reason: `Queue depth is elevated (${sorobanDepth}/${sc.hardLimit} pending Soroban writes). Proceeding with caution.`,
      retryAfterSeconds: 0,
    };
  }

  return {
    decision: 'admit',
    saturationRatio: snapshot.overallSaturationRatio,
    sorobanQueueDepth: sorobanDepth,
    webhookQueueDepth: snapshot.webhookRetryQueueDepth,
    reason: 'Queue capacity is within normal range.',
    retryAfterSeconds: 0,
  };
}

// ── Periodic refresh scheduler ────────────────────────────────────────────────

let _refreshInterval: NodeJS.Timeout | null = null;

/**
 * Start the background saturation refresh loop.
 *
 * Reads queue depths every `QUEUE_BACKPRESSURE_REFRESH_INTERVAL_MS` (default
 * 10 s) and updates the cached snapshot so `checkQueueAdmission()` has a
 * reasonably fresh view without paying a DB round-trip on every request.
 *
 * Safe to call multiple times — only one loop is started.
 */
export function startQueueBackpressureRefresh(): void {
  if (_refreshInterval) return;

  const intervalMs = readPositiveInt('QUEUE_BACKPRESSURE_REFRESH_INTERVAL_MS', 10_000);

  logger.info('[queue-backpressure] Starting backpressure refresh loop', { intervalMs });

  _refreshInterval = setInterval(() => {
    void readQueueSaturation(true).catch((err) => {
      logger.warn('[queue-backpressure] Refresh loop error', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, intervalMs);

  _refreshInterval.unref();
}

/** Stop the background refresh loop (called during graceful shutdown). */
export function stopQueueBackpressureRefresh(): void {
  if (_refreshInterval) {
    clearInterval(_refreshInterval);
    _refreshInterval = null;
    logger.info('[queue-backpressure] Backpressure refresh loop stopped');
  }
}

/** Reset cached snapshot (used by tests). */
export function resetQueueSaturationSnapshot(): void {
  _lastSnapshot = {
    capturedAt: 0,
    sorobanWriteQueueDepth: 0,
    webhookRetryQueueDepth: 0,
    sorobanSaturationRatio: 0,
    webhookSaturationRatio: 0,
    overallSaturationRatio: 0,
    degraded: false,
    pressured: false,
    saturated: false,
  };
}
