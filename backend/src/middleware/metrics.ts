import type { NextFunction, Request, Response } from 'express';
import client from 'prom-client';
import { query } from '../db/connection.js';
import type { AdaptiveScheduler, SchedulerMode } from '../services/adaptiveScheduler.js';
import logger from '../utils/logger.js';

export const metricsRegistry = new client.Registry();

client.collectDefaultMetrics({ register: metricsRegistry });

export const traceContextCounter = new client.Counter({
  name: 'trace_context_requests_total',
  help: 'Inbound requests by trace-context resolution outcome (incoming, generated, invalid).',
  labelNames: ['source'] as const,
  registers: [metricsRegistry],
});

export const challengeNonceCounter = new client.Counter({
  name: 'auth_challenge_nonce_total',
  help: 'Authentication challenge nonce outcomes.',
  labelNames: ['outcome'] as const,
  registers: [metricsRegistry],
});

export const chainConfirmationCounter = new client.Counter({
  name: 'chain_confirmation_total',
  help: 'Soroban transaction confirmation outcomes observed by the API (success, failed, not_found, error).',
  labelNames: ['status'] as const,
  registers: [metricsRegistry],
});

export const chainConfirmationDurationHistogram = new client.Histogram({
  name: 'chain_confirmation_duration_seconds',
  help: 'Wall-clock seconds from transaction submission to observed chain confirmation.',
  labelNames: ['status'] as const,
  buckets: [0.5, 1, 2, 5, 10, 20, 30, 60],
  registers: [metricsRegistry],
});

export const indexerLastLedgerGauge = new client.Gauge({
  name: 'indexer_last_ledger',
  help: 'Last ledger successfully processed by the event indexer.',
  registers: [metricsRegistry],
});

export const indexerChainTipGauge = new client.Gauge({
  name: 'indexer_chain_tip',
  help: 'Latest ledger observed from the chain RPC.',
  registers: [metricsRegistry],
});

export const indexerLagLedgersGauge = new client.Gauge({
  name: 'indexer_lag_ledgers',
  help: 'Difference between the latest chain ledger and the last indexed ledger.',
  registers: [metricsRegistry],
});

export const webhookRetryQueueDepthGauge = new client.Gauge({
  name: 'webhook_retry_queue_depth',
  help: 'Number of webhook deliveries currently waiting for retry.',
  registers: [metricsRegistry],
});

// ---------------------------------------------------------------------------
// Queue backpressure saturation metrics (issue #860)
// ---------------------------------------------------------------------------

/**
 * Current number of pending rows in the Soroban write queue.
 * Values at or above SOROBAN_QUEUE_HARD_LIMIT indicate the queue is saturated.
 */
export const sorobanWriteQueueDepthGauge = new client.Gauge({
  name: 'soroban_write_queue_depth',
  help: 'Number of pending rows in the Soroban on-chain write queue.',
  registers: [metricsRegistry],
});

/**
 * Current backpressure saturation ratio for the Soroban write queue (0–1).
 * Value = soroban_write_queue_depth / SOROBAN_QUEUE_HARD_LIMIT.
 */
export const sorobanWriteQueueSaturationGauge = new client.Gauge({
  name: 'soroban_write_queue_saturation_ratio',
  help: 'Soroban write-queue saturation as a fraction of the hard-capacity limit (0=empty, 1=fully saturated).',
  registers: [metricsRegistry],
});

/**
 * Overall queue saturation ratio across all job classes (0–1).
 * Maximum of the per-queue saturation ratios.
 */
export const overallQueueSaturationGauge = new client.Gauge({
  name: 'queue_overall_saturation_ratio',
  help: 'Maximum saturation ratio across all job-class queues (0=empty, 1=fully saturated).',
  registers: [metricsRegistry],
});

/**
 * Number of financial write requests rejected due to queue saturation.
 * Incremented each time the admission-control middleware returns 503.
 */
export const queueAdmissionRejectionsCounter = new client.Counter({
  name: 'queue_admission_rejections_total',
  help: 'Financial write requests rejected by the queue backpressure admission-control middleware.',
  labelNames: ['job_class'] as const,
  registers: [metricsRegistry],
});

/**
 * Number of background job ticks shed due to queue pressure.
 * Incremented each time shouldBackgroundJobRun() returns run=false.
 */
export const queueBackgroundShedsCounter = new client.Counter({
  name: 'queue_background_sheds_total',
  help: 'Background job ticks shed by the queue backpressure gate.',
  labelNames: ['job_class'] as const,
  registers: [metricsRegistry],
});

export const scoreReconciliationLastRunTimestampGauge = new client.Gauge({
  name: 'score_reconciliation_last_run_timestamp',
  help: 'Unix timestamp in seconds for the last score reconciliation run.',
  registers: [metricsRegistry],
});

export const deprecatedApiUsageCounter = new client.Counter({
  name: 'deprecated_api_requests_total',
  help: 'Requests served by deprecated API surfaces, by matched route template and sanitized client version cohort.',
  labelNames: ['route', 'client_version'] as const,
  registers: [metricsRegistry],
});

export const httpRequestDurationHistogram = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds.',
  labelNames: ['method', 'route', 'status_class'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
});

export const dbQueryDurationHistogram = new client.Histogram({
  name: 'db_query_duration_seconds',
  help: 'Database query duration in seconds.',
  labelNames: ['operation', 'table'] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [metricsRegistry],
});

export const cacheHitRateCounter = new client.Counter({
  name: 'cache_hits_total',
  help: 'Total number of cache hits.',
  labelNames: ['key_pattern'] as const,
  registers: [metricsRegistry],
});

export const cacheMissRateCounter = new client.Counter({
  name: 'cache_misses_total',
  help: 'Total number of cache misses.',
  labelNames: ['key_pattern'] as const,
  registers: [metricsRegistry],
});

/** Bounded labels: resource is a CacheResource name, outcome is a fixed enum. */
export const cacheStaleReadCounter = new client.Counter({
  name: 'cache_stale_reads_total',
  help: 'Financial cache reads by resource and outcome (fresh, miss, backend_error, race_skipped).',
  labelNames: ['resource', 'outcome'] as const,
  registers: [metricsRegistry],
});

export const cacheInvalidationFailureCounter = new client.Counter({
  name: 'cache_invalidation_failures_total',
  help: 'Cache invalidations that could not be confirmed (Redis unreachable), by resource.',
  labelNames: ['resource'] as const,
  registers: [metricsRegistry],
});

export const cacheInvalidationCounter = new client.Counter({
  name: 'cache_invalidations_total',
  help: 'Cache invalidations attempted, by resource.',
  labelNames: ['resource'] as const,
  registers: [metricsRegistry],
});

export const loanApprovalRateCounter = new client.Counter({
  name: 'loan_approvals_total',
  help: 'Total number of approved loans.',
  labelNames: ['loan_type'] as const,
  registers: [metricsRegistry],
});

export const loanRejectionRateCounter = new client.Counter({
  name: 'loan_rejections_total',
  help: 'Total number of rejected loans.',
  labelNames: ['rejection_reason'] as const,
  registers: [metricsRegistry],
});

export const poolUtilizationGauge = new client.Gauge({
  name: 'pool_utilization_ratio',
  help: 'Current utilization ratio of the lending pool (0-1).',
  labelNames: ['pool_id'] as const,
  registers: [metricsRegistry],
});

export const activeLoansGauge = new client.Gauge({
  name: 'active_loans_total',
  help: 'Total number of currently active loans.',
  labelNames: ['status'] as const,
  registers: [metricsRegistry],
});

export const transactionProcessingTimeHistogram = new client.Histogram({
  name: 'transaction_processing_time_seconds',
  help: 'Time taken to process a transaction on-chain.',
  labelNames: ['transaction_type'] as const,
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
  registers: [metricsRegistry],
});

// ---------------------------------------------------------------------------
// Adaptive scheduler metrics
// ---------------------------------------------------------------------------

/**
 * Maps SchedulerMode string values to numeric gauge values following the
 * convention documented in indexer_scheduler_mode help text:
 *   0 = caught_up, 1 = behind, 2 = catch_up
 */
const SCHEDULER_MODE_VALUE: Record<SchedulerMode, number> = {
  caught_up: 0,
  behind: 1,
  catch_up: 2,
};

/**
 * Current operating mode of the adaptive scheduler.
 * Values: 0=caught_up, 1=behind, 2=catch_up
 */
export const indexerSchedulerModeGauge = new client.Gauge({
  name: 'indexer_scheduler_mode',
  help: 'Current operating mode of the adaptive scheduler (0=caught_up, 1=behind, 2=catch_up).',
  labelNames: ['contract_id'] as const,
  registers: [metricsRegistry],
});

/**
 * Current exponential-backoff level (0 = no backoff; increments by 1 per
 * consecutive RPC failure, reset to 0 on success).
 */
export const indexerBackoffLevelGauge = new client.Gauge({
  name: 'indexer_backoff_level',
  help: 'Current exponential-backoff level for the adaptive scheduler (0 = no backoff, N = Nth failure tier).',
  labelNames: ['contract_id'] as const,
  registers: [metricsRegistry],
});

/**
 * Number of consecutive RPC failures since the last successful poll.
 */
export const indexerConsecutiveFailuresGauge = new client.Gauge({
  name: 'indexer_consecutive_failures',
  help: 'Number of consecutive RPC failures recorded by the adaptive scheduler since the last successful poll.',
  labelNames: ['contract_id'] as const,
  registers: [metricsRegistry],
});

/**
 * Total number of scheduler mode transitions.
 * Label `from` and `to` carry the originating and destination mode names.
 */
export const indexerModeTransitionsCounter = new client.Counter({
  name: 'indexer_mode_transitions_total',
  help: 'Total number of adaptive-scheduler mode transitions.',
  labelNames: ['from', 'to'] as const,
  registers: [metricsRegistry],
});

/**
 * Total number of times exponential backoff was triggered (i.e. the
 * consecutive-failure counter was incremented from 0→1 or higher).
 */
export const indexerBackoffTriggeredCounter = new client.Counter({
  name: 'indexer_backoff_triggered_total',
  help: 'Total number of times the adaptive-scheduler backoff was triggered by an RPC failure.',
  labelNames: ['contract_id'] as const,
  registers: [metricsRegistry],
});

// ---------------------------------------------------------------------------
// Adaptive scheduler export helper
// ---------------------------------------------------------------------------

/**
 * Read the in-memory state of `scheduler` and push it to the three adaptive
 * scheduler gauges.  Call this after every successful or failed poll cycle.
 *
 * NOTE: This deliberately uses the synchronous in-memory view of the
 * scheduler (via getState()) rather than hitting the DB, so it is safe to
 * call in hot polling loops without adding extra I/O.
 *
 * @param scheduler  The AdaptiveScheduler instance to inspect.
 * @param contractId The contract ID label to attach to the metrics.
 */
export async function exportAdaptiveSchedulerMetrics(
  scheduler: AdaptiveScheduler,
  contractId: string,
): Promise<void> {
  try {
    const state = await scheduler.getState();

    indexerSchedulerModeGauge.set(
      { contract_id: contractId },
      SCHEDULER_MODE_VALUE[state.mode] ?? 0,
    );

    indexerBackoffLevelGauge.set({ contract_id: contractId }, state.consecutiveFailures);

    indexerConsecutiveFailuresGauge.set({ contract_id: contractId }, state.consecutiveFailures);
  } catch (error) {
    logger.warn('Failed to export adaptive scheduler metrics', { contractId, error });
  }
}

/**
 * Record a scheduler mode transition in the counter.
 * Intended to be called from AdaptiveScheduler.recordModeTransition (or the
 * caller of calculateNextPoll) whenever a transition is detected.
 *
 * @param from  The previous SchedulerMode.
 * @param to    The new SchedulerMode.
 */
export function recordSchedulerModeTransition(from: SchedulerMode, to: SchedulerMode): void {
  indexerModeTransitionsCounter.inc({ from, to });
}

/**
 * Record that backoff was triggered (a new RPC failure incremented the
 * consecutive-failure counter).
 *
 * @param contractId The contract ID label.
 */
export function recordBackoffTriggered(contractId: string): void {
  indexerBackoffTriggeredCounter.inc({ contract_id: contractId });
}

export function routeLabel(req: Request): string {
  const routePath = req.route?.path;
  if (typeof routePath === 'string') {
    return `${req.baseUrl}${routePath}` || req.path;
  }

  if (Array.isArray(routePath)) {
    return `${req.baseUrl}${routePath.join('|')}`;
  }

  return 'unmatched';
}

export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const endTimer = httpRequestDurationHistogram.startTimer();

  res.on('finish', () => {
    endTimer({
      method: req.method,
      route: routeLabel(req),
      status_class: `${Math.floor(res.statusCode / 100)}xx`,
    });
  });

  next();
}

export function recordIndexerLedgers(lastLedger: number, chainTip: number): void {
  indexerLastLedgerGauge.set(lastLedger);
  indexerChainTipGauge.set(chainTip);
  indexerLagLedgersGauge.set(Math.max(chainTip - lastLedger, 0));
}

export function recordScoreReconciliationRun(date = new Date()): void {
  scoreReconciliationLastRunTimestampGauge.set(Math.floor(date.getTime() / 1000));
}

export async function refreshWebhookRetryQueueDepth(): Promise<void> {
  try {
    const result = await query(
      `SELECT COUNT(*)::int AS count
       FROM webhook_deliveries
       WHERE delivered_at IS NULL
         AND next_retry_at IS NOT NULL`,
      [],
    );
    webhookRetryQueueDepthGauge.set(Number(result.rows[0]?.count ?? 0));
  } catch (error) {
    logger.warn('Failed to refresh webhook retry queue depth metric', {
      error,
    });
  }
}

export async function metricsHandler(_req: Request, res: Response): Promise<void> {
  res.set('Content-Type', metricsRegistry.contentType);
  res.send(await metricsRegistry.metrics());
}

export function recordDbQueryDuration(duration: number, operation: string, table: string): void {
  dbQueryDurationHistogram.observe({ operation, table }, duration);
}

export function recordCacheHit(keyPattern: string): void {
  cacheHitRateCounter.inc({ key_pattern: keyPattern });
}

export function recordCacheMiss(keyPattern: string): void {
  cacheMissRateCounter.inc({ key_pattern: keyPattern });
}

/**
 * Update the queue-depth and saturation-ratio gauges from a backpressure
 * snapshot.  Call this after every backpressure refresh pass so Prometheus
 * always has an up-to-date view of queue capacity.
 *
 * @param sorobanDepth      Current pending row count in soroban_write_queue.
 * @param webhookDepth      Current retry row count in webhook_deliveries.
 * @param saturationRatio   Overall saturation ratio (max across all queues).
 */
export function recordQueueSaturation(
  sorobanDepth: number,
  webhookDepth: number,
  saturationRatio: number,
): void {
  sorobanWriteQueueDepthGauge.set(sorobanDepth);
  webhookRetryQueueDepthGauge.set(webhookDepth);
  sorobanWriteQueueSaturationGauge.set(
    Math.min(saturationRatio, 1),
  );
  overallQueueSaturationGauge.set(Math.min(saturationRatio, 1));
}

export function recordLoanApproval(loanType: string = 'standard'): void {
  loanApprovalRateCounter.inc({ loan_type: loanType });
}

export function recordLoanRejection(rejectionReason: string = 'unknown'): void {
  loanRejectionRateCounter.inc({ rejection_reason: rejectionReason });
}

export function updatePoolUtilization(poolId: string, utilizationRatio: number): void {
  poolUtilizationGauge.set({ pool_id: poolId }, Math.max(0, Math.min(1, utilizationRatio)));
}

export function updateActiveLoans(status: string, count: number): void {
  activeLoansGauge.set({ status }, count);
}

export function recordTransactionProcessingTime(duration: number, transactionType: string): void {
  transactionProcessingTimeHistogram.observe({ transaction_type: transactionType }, duration);
}

// ── PostgreSQL pool saturation (no user-identifying labels) ─────────────
export const dbPoolWaitDurationHistogram = new client.Histogram({
  name: 'db_pool_wait_duration_seconds',
  help: 'Time spent waiting to acquire a PostgreSQL pool connection.',
  buckets: [0.001, 0.005, 0.025, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
});

export const dbPoolSaturationGauge = new client.Gauge({
  name: 'db_pool_saturation_ratio',
  help: 'Checked-out connections divided by DB_POOL_MAX (0-1).',
  registers: [metricsRegistry],
});

export const dbPoolWaitingGauge = new client.Gauge({
  name: 'db_pool_waiting_requests',
  help: 'Requests currently queued waiting for a pool connection.',
  registers: [metricsRegistry],
});

export const dbPoolTimeoutsCounter = new client.Counter({
  name: 'db_pool_acquire_timeouts_total',
  help: 'Pool acquisitions that exceeded the bounded wait deadline.',
  registers: [metricsRegistry],
});

export const dbPoolRejectedCounter = new client.Counter({
  name: 'db_pool_rejected_total',
  help: 'Requests rejected immediately because the pool wait queue was full.',
  registers: [metricsRegistry],
});
