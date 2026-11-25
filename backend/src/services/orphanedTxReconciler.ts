/**
 * Durable reconciliation for orphaned transaction submissions (issue #858).
 *
 * An "orphaned" submission is a row in transaction_submissions whose status is
 * not `confirmed` or `failed` and whose submitted_at is older than the
 * configured detection threshold. This happens when a client or worker lost
 * the response after submitting a signed transaction to the Soroban RPC.
 *
 * The reconciler runs on a scheduler and processes each orphaned submission
 * through the following state machine:
 *
 *   submitted (implicit) ──► pending_check
 *                               │
 *                     RPC lookup on each pass
 *                               │
 *            ┌──────────────────┼──────────────────┐
 *            ▼                  ▼                  ▼
 *       confirmed        failed_on_chain     not found yet
 *                                               │
 *                                 finality window elapsed?
 *                                    NO             YES
 *                                     │               │
 *                              finality_pending    orphaned
 *                                                     │
 *                                           resubmit_approved_by set?
 *                                                     │
 *                                                resubmitted
 *
 *   Any state ──► resolved  (operator manual resolution)
 *
 * Safety invariants:
 *   - Resubmission is only permitted from `orphaned` state.
 *   - A resubmission attempt while state is `finality_pending` is rejected
 *     with a 409 so there are never partial financial side effects.
 *   - Confirmed and failed_on_chain are terminal; resubmission is blocked.
 *   - The finality window is a minimum of 30 s and defaults to 5 minutes;
 *     configured via ORPHANED_TX_FINALITY_WINDOW_MS.
 *   - Detection threshold (minimum age before classification) defaults to
 *     60 s; configured via ORPHANED_TX_DETECTION_THRESHOLD_MS.
 */

import { query } from '../db/connection.js';
import { jobMetricsService } from './jobMetricsService.js';
import logger from '../utils/logger.js';

// ── Types ─────────────────────────────────────────────────────────────────

export type OrphanedTxState =
  | 'pending_check'
  | 'finality_pending'
  | 'confirmed'
  | 'failed_on_chain'
  | 'orphaned'
  | 'resubmitted'
  | 'resolved';

export interface OrphanedTxRow {
  id: number;
  submissionId: number;
  txHash: string;
  submittedBy: string | null;
  transactionType: string;
  state: OrphanedTxState;
  checkAttempts: number;
  lastRpcCheckAt: Date | null;
  confirmedLedger: number | null;
  rpcResultXdr: string | null;
  rpcErrorDetail: string | null;
  finalityDeadlineAt: Date;
  resubmitApprovedBy: string | null;
  resubmittedAt: Date | null;
  resubmitTxHash: string | null;
  resolutionNote: string | null;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReconciliationRunResult {
  detected: number;
  processed: number;
  confirmedCount: number;
  failedOnChainCount: number;
  finalityPendingCount: number;
  orphanedCount: number;
  skipped: boolean;
  errors: number;
}

export interface ResubmitInput {
  reconciliationId: number;
  approvedBy: string;
  newTxHash: string;
}

export interface ResolveInput {
  reconciliationId: number;
  resolvedBy: string;
  resolutionNote: string;
}

// ── RPC adapter interface (injectable for tests) ─────────────────────────

export interface RpcLookupResult {
  found: boolean;
  status?: 'SUCCESS' | 'FAILED' | 'NOT_FOUND';
  ledger?: number;
  resultXdr?: string;
  errorDetail?: string;
}

export type RpcLookupFn = (txHash: string) => Promise<RpcLookupResult>;

// ── Config helpers ────────────────────────────────────────────────────────

const MIN_FINALITY_WINDOW_MS = 30_000; // 30 s hard floor

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getFinalityWindowMs(): number {
  return Math.max(
    readPositiveInt('ORPHANED_TX_FINALITY_WINDOW_MS', 5 * 60_000), // 5 min default
    MIN_FINALITY_WINDOW_MS,
  );
}

function getDetectionThresholdMs(): number {
  return readPositiveInt('ORPHANED_TX_DETECTION_THRESHOLD_MS', 60_000); // 1 min default
}

function getBatchSize(): number {
  return readPositiveInt('ORPHANED_TX_BATCH_SIZE', 50);
}

function getIntervalMs(): number {
  return readPositiveInt('ORPHANED_TX_RECONCILE_INTERVAL_MS', 60_000); // 1 min default
}

// ── DB helpers ────────────────────────────────────────────────────────────

function mapRow(row: Record<string, unknown>): OrphanedTxRow {
  return {
    id: Number(row.id),
    submissionId: Number(row.submission_id),
    txHash: String(row.tx_hash ?? ''),
    submittedBy: row.submitted_by != null ? String(row.submitted_by) : null,
    transactionType: String(row.transaction_type ?? 'loan'),
    state: String(row.state ?? 'pending_check') as OrphanedTxState,
    checkAttempts: Number(row.check_attempts ?? 0),
    lastRpcCheckAt: row.last_rpc_check_at ? new Date(String(row.last_rpc_check_at)) : null,
    confirmedLedger: row.confirmed_ledger != null ? Number(row.confirmed_ledger) : null,
    rpcResultXdr: row.rpc_result_xdr != null ? String(row.rpc_result_xdr) : null,
    rpcErrorDetail: row.rpc_error_detail != null ? String(row.rpc_error_detail) : null,
    finalityDeadlineAt: new Date(String(row.finality_deadline_at)),
    resubmitApprovedBy: row.resubmit_approved_by != null ? String(row.resubmit_approved_by) : null,
    resubmittedAt: row.resubmitted_at ? new Date(String(row.resubmitted_at)) : null,
    resubmitTxHash: row.resubmit_tx_hash != null ? String(row.resubmit_tx_hash) : null,
    resolutionNote: row.resolution_note != null ? String(row.resolution_note) : null,
    resolvedBy: row.resolved_by != null ? String(row.resolved_by) : null,
    resolvedAt: row.resolved_at ? new Date(String(row.resolved_at)) : null,
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
  };
}

// ── Reconciler class ──────────────────────────────────────────────────────

class OrphanedTxReconciler {
  /**
   * Detect new orphaned submissions: rows in transaction_submissions that are
   * older than the detection threshold, not yet finished, and have no
   * reconciliation row. Inserts one `pending_check` row per detection.
   * Idempotent via ON CONFLICT DO NOTHING.
   */
  async detectNewOrphans(): Promise<number> {
    const thresholdMs = getDetectionThresholdMs();
    const finalityWindowMs = getFinalityWindowMs();
    const batchSize = getBatchSize();

    const result = await query(
      `INSERT INTO orphaned_tx_reconciliation
         (submission_id, tx_hash, submitted_by, transaction_type,
          state, finality_deadline_at)
       SELECT
         ts.id,
         ts.tx_hash,
         ts.submitted_by,
         ts.transaction_type,
         'pending_check',
         NOW() + ($1 * INTERVAL '1 millisecond')
       FROM transaction_submissions ts
       WHERE ts.status NOT IN ('confirmed', 'failed')
         AND ts.submitted_at < NOW() - ($2 * INTERVAL '1 millisecond')
         AND NOT EXISTS (
           SELECT 1 FROM orphaned_tx_reconciliation otr
           WHERE otr.submission_id = ts.id
         )
       ORDER BY ts.submitted_at ASC
       LIMIT $3
       ON CONFLICT (submission_id) DO NOTHING`,
      [finalityWindowMs, thresholdMs, batchSize],
    );

    return result.rowCount ?? 0;
  }

  /**
   * Fetch the next batch of non-terminal reconciliation rows for processing.
   */
  async fetchPendingRows(): Promise<OrphanedTxRow[]> {
    const result = await query(
      `SELECT *
       FROM orphaned_tx_reconciliation
       WHERE state IN ('pending_check', 'finality_pending')
       ORDER BY created_at ASC
       LIMIT $1`,
      [getBatchSize()],
    );
    return (result.rows as Record<string, unknown>[]).map(mapRow);
  }

  /**
   * Advance state machine for a single row based on the RPC lookup result.
   */
  async processRow(row: OrphanedTxRow, rpcLookup: RpcLookupFn): Promise<OrphanedTxState> {
    let lookupResult: RpcLookupResult;
    try {
      lookupResult = await rpcLookup(row.txHash);
    } catch (err) {
      // RPC unavailable: increment attempt counter but do not change state.
      await query(
        `UPDATE orphaned_tx_reconciliation
         SET check_attempts = check_attempts + 1,
             last_rpc_check_at = NOW(),
             rpc_error_detail = $2,
             updated_at = NOW()
         WHERE id = $1`,
        [row.id, err instanceof Error ? err.message : String(err)],
      );
      // Also mark the submission's last_checked_at so the scan index stays fresh.
      await query(
        `UPDATE transaction_submissions
         SET last_checked_at = NOW(),
             reconciliation_state = 'pending_check'
         WHERE id = $1`,
        [row.submissionId],
      );
      throw err;
    }

    const now = new Date();

    if (lookupResult.found) {
      if (!lookupResult.status || lookupResult.status === 'NOT_FOUND') {
        // Edge case: found=true but status not provided — treat as not_found.
        return this.advanceNotFound(row, now);
      }

      if (lookupResult.status === 'SUCCESS') {
        await this.markConfirmed(row, lookupResult);
        return 'confirmed';
      }

      // status === 'FAILED'
      await this.markFailedOnChain(row, lookupResult);
      return 'failed_on_chain';
    }

    return this.advanceNotFound(row, now);
  }

  private async advanceNotFound(
    row: OrphanedTxRow,
    now: Date,
  ): Promise<OrphanedTxState> {
    const finalityElapsed = now >= row.finalityDeadlineAt;

    if (!finalityElapsed) {
      // Still within the finality window — not safe to classify as orphaned yet.
      await query(
        `UPDATE orphaned_tx_reconciliation
         SET state = 'finality_pending',
             check_attempts = check_attempts + 1,
             last_rpc_check_at = NOW(),
             updated_at = NOW()
         WHERE id = $1`,
        [row.id],
      );
      await query(
        `UPDATE transaction_submissions
         SET reconciliation_state = 'finality_pending',
             first_checked_at = COALESCE(first_checked_at, NOW()),
             last_checked_at = NOW()
         WHERE id = $1`,
        [row.submissionId],
      );
      return 'finality_pending';
    }

    // Finality window has elapsed and tx is still not found → orphaned.
    await query(
      `UPDATE orphaned_tx_reconciliation
       SET state = 'orphaned',
           check_attempts = check_attempts + 1,
           last_rpc_check_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [row.id],
    );
    await query(
      `UPDATE transaction_submissions
       SET status = 'orphaned',
           reconciliation_state = 'orphaned',
           first_checked_at = COALESCE(first_checked_at, NOW()),
           last_checked_at = NOW()
       WHERE id = $1`,
      [row.submissionId],
    );

    logger.withContext().warn('orphaned_tx_reconciler.tx_orphaned', {
      reconciliationId: row.id,
      txHash: row.txHash,
      submissionId: row.submissionId,
      checkAttempts: row.checkAttempts + 1,
    });

    return 'orphaned';
  }

  private async markConfirmed(row: OrphanedTxRow, result: RpcLookupResult): Promise<void> {
    await query(
      `UPDATE orphaned_tx_reconciliation
       SET state = 'confirmed',
           check_attempts = check_attempts + 1,
           last_rpc_check_at = NOW(),
           confirmed_ledger = $2,
           rpc_result_xdr = $3,
           updated_at = NOW()
       WHERE id = $1`,
      [row.id, result.ledger ?? null, result.resultXdr ?? null],
    );
    await query(
      `UPDATE transaction_submissions
       SET status = 'confirmed',
           result_xdr = COALESCE(result_xdr, $2),
           reconciliation_state = 'confirmed',
           first_checked_at = COALESCE(first_checked_at, NOW()),
           last_checked_at = NOW()
       WHERE id = $1`,
      [row.submissionId, result.resultXdr ?? null],
    );
  }

  private async markFailedOnChain(row: OrphanedTxRow, result: RpcLookupResult): Promise<void> {
    await query(
      `UPDATE orphaned_tx_reconciliation
       SET state = 'failed_on_chain',
           check_attempts = check_attempts + 1,
           last_rpc_check_at = NOW(),
           confirmed_ledger = $2,
           rpc_result_xdr = $3,
           rpc_error_detail = $4,
           updated_at = NOW()
       WHERE id = $1`,
      [row.id, result.ledger ?? null, result.resultXdr ?? null, result.errorDetail ?? null],
    );
    await query(
      `UPDATE transaction_submissions
       SET status = 'failed',
           result_xdr = COALESCE(result_xdr, $2),
           reconciliation_state = 'failed_on_chain',
           first_checked_at = COALESCE(first_checked_at, NOW()),
           last_checked_at = NOW()
       WHERE id = $1`,
      [row.submissionId, result.resultXdr ?? null],
    );
  }

  /**
   * Run one full reconciliation pass: detect new orphans, then advance each
   * pending row through the state machine.
   */
  async run(rpcLookup: RpcLookupFn): Promise<ReconciliationRunResult> {
    const startTime = Date.now();
    const JOB_NAME = 'orphanedTxReconciler';

    const result: ReconciliationRunResult = {
      detected: 0,
      processed: 0,
      confirmedCount: 0,
      failedOnChainCount: 0,
      finalityPendingCount: 0,
      orphanedCount: 0,
      skipped: false,
      errors: 0,
    };

    try {
      result.detected = await this.detectNewOrphans();
      const rows = await this.fetchPendingRows();

      logger.withContext().info('orphaned_tx_reconciler.run.start', {
        detected: result.detected,
        pendingRows: rows.length,
      });

      for (const row of rows) {
        result.processed += 1;
        try {
          const newState = await this.processRow(row, rpcLookup);
          switch (newState) {
            case 'confirmed':
              result.confirmedCount += 1;
              break;
            case 'failed_on_chain':
              result.failedOnChainCount += 1;
              break;
            case 'finality_pending':
              result.finalityPendingCount += 1;
              break;
            case 'orphaned':
              result.orphanedCount += 1;
              break;
            default:
              break;
          }
        } catch (err) {
          result.errors += 1;
          logger.withContext().error('orphaned_tx_reconciler.row_error', {
            reconciliationId: row.id,
            txHash: row.txHash,
            error: err,
          });
          // Continue with the next row — do not let one RPC failure stall all.
        }
      }

      logger.withContext().info('orphaned_tx_reconciler.run.complete', { ...result });
      jobMetricsService.recordSuccess(JOB_NAME, Date.now() - startTime);
    } catch (err) {
      result.skipped = true;
      jobMetricsService.recordFailure(JOB_NAME, err as Error, Date.now() - startTime);
      logger.withContext().error('orphaned_tx_reconciler.run.error', { error: err });
      throw err;
    }

    return result;
  }
}

export const orphanedTxReconciler = new OrphanedTxReconciler();

// ── Public service API (used by controller) ───────────────────────────────

/**
 * Look up a reconciliation row by its tx_hash. Returns null if not found.
 */
export async function getReconciliationByTxHash(
  txHash: string,
): Promise<OrphanedTxRow | null> {
  const result = await query(
    `SELECT * FROM orphaned_tx_reconciliation WHERE tx_hash = $1 LIMIT 1`,
    [txHash],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  return row ? mapRow(row) : null;
}

/**
 * Look up a reconciliation row by its numeric id.
 */
export async function getReconciliationById(id: number): Promise<OrphanedTxRow | null> {
  const result = await query(
    `SELECT * FROM orphaned_tx_reconciliation WHERE id = $1 LIMIT 1`,
    [id],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  return row ? mapRow(row) : null;
}

/**
 * Approve resubmission of an orphaned transaction.
 *
 * Rules:
 *   - state must be `orphaned` (not finality_pending, confirmed, failed_on_chain, etc.)
 *   - approvedBy must be the original submitter or a privileged admin key
 *   - newTxHash must be non-empty and distinct from the original tx_hash
 *   - Idempotent: if state is already `resubmitted`, returns the existing row
 */
export async function approveResubmit(input: ResubmitInput): Promise<OrphanedTxRow> {
  const row = await getReconciliationById(input.reconciliationId);
  if (!row) {
    throw Object.assign(new Error('Reconciliation record not found'), {
      statusCode: 404,
      errorCode: 'TX_NOT_FOUND',
    });
  }

  if (row.state === 'resubmitted') {
    // Idempotent — already processed.
    return row;
  }

  if (row.state !== 'orphaned') {
    const reason =
      row.state === 'finality_pending'
        ? 'Transaction is within the finality window; resubmission is blocked until the window elapses.'
        : row.state === 'confirmed'
          ? 'Transaction has been confirmed on-chain; resubmission is not needed.'
          : row.state === 'failed_on_chain'
            ? 'Transaction failed on-chain; correct the transaction before resubmitting.'
            : `Resubmission is not permitted in state '${row.state}'.`;

    throw Object.assign(new Error(reason), {
      statusCode: 409,
      errorCode: 'TX_RESUBMIT_BLOCKED',
      state: row.state,
    });
  }

  if (!input.newTxHash || input.newTxHash.trim().length === 0) {
    throw Object.assign(new Error('newTxHash is required'), {
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
    });
  }

  if (input.newTxHash === row.txHash) {
    throw Object.assign(new Error('newTxHash must differ from the original tx_hash'), {
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
    });
  }

  if (!input.approvedBy || input.approvedBy.trim().length === 0) {
    throw Object.assign(new Error('approvedBy is required'), {
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
    });
  }

  await query(
    `UPDATE orphaned_tx_reconciliation
     SET state = 'resubmitted',
         resubmit_approved_by = $2,
         resubmitted_at = NOW(),
         resubmit_tx_hash = $3,
         updated_at = NOW()
     WHERE id = $1 AND state = 'orphaned'`,
    [row.id, input.approvedBy, input.newTxHash],
  );

  await query(
    `UPDATE transaction_submissions
     SET reconciliation_state = 'resubmitted',
         last_checked_at = NOW()
     WHERE id = $1`,
    [row.submissionId],
  );

  logger.withContext().info('orphaned_tx_reconciler.resubmit_approved', {
    reconciliationId: row.id,
    txHash: row.txHash,
    newTxHash: input.newTxHash,
    approvedBy: input.approvedBy,
  });

  const updated = await getReconciliationById(row.id);
  return updated!;
}

/**
 * Manually resolve an orphaned reconciliation row (operator decision).
 * Permitted from any non-terminal state to allow operators to close stale
 * rows. Requires a minimum 10-character resolution note.
 */
export async function resolveReconciliation(input: ResolveInput): Promise<OrphanedTxRow> {
  if (!input.resolvedBy || input.resolvedBy.trim().length === 0) {
    throw Object.assign(new Error('resolvedBy is required'), {
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
    });
  }
  if (!input.resolutionNote || input.resolutionNote.trim().length < 10) {
    throw Object.assign(new Error('resolutionNote of at least 10 characters is required'), {
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
    });
  }

  const row = await getReconciliationById(input.reconciliationId);
  if (!row) {
    throw Object.assign(new Error('Reconciliation record not found'), {
      statusCode: 404,
      errorCode: 'TX_NOT_FOUND',
    });
  }

  if (row.state === 'resolved') {
    return row; // idempotent
  }

  await query(
    `UPDATE orphaned_tx_reconciliation
     SET state = 'resolved',
         resolved_by = $2,
         resolved_at = NOW(),
         resolution_note = $3,
         updated_at = NOW()
     WHERE id = $1`,
    [row.id, input.resolvedBy, input.resolutionNote],
  );

  await query(
    `UPDATE transaction_submissions
     SET reconciliation_state = 'resolved',
         last_checked_at = NOW()
     WHERE id = $1`,
    [row.submissionId],
  );

  logger.withContext().info('orphaned_tx_reconciler.resolved', {
    reconciliationId: row.id,
    txHash: row.txHash,
    resolvedBy: input.resolvedBy,
  });

  const updated = await getReconciliationById(row.id);
  return updated!;
}

/**
 * List reconciliation rows, optionally filtered by state, with cursor
 * pagination. Used by the admin list endpoint.
 */
export async function listReconciliations(opts: {
  state?: OrphanedTxState;
  limit?: number;
  cursor?: number;
}): Promise<OrphanedTxRow[]> {
  const limit = Math.min(opts.limit ?? 50, 200);
  const params: unknown[] = [limit + 1];
  const conditions: string[] = [];

  if (opts.state) {
    params.push(opts.state);
    conditions.push(`state = $${params.length}`);
  }
  if (opts.cursor) {
    params.push(opts.cursor);
    conditions.push(`id < $${params.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await query(
    `SELECT * FROM orphaned_tx_reconciliation ${where} ORDER BY id DESC LIMIT $1`,
    params,
  );
  return (result.rows as Record<string, unknown>[]).map(mapRow).slice(0, limit);
}

// ── Scheduler ─────────────────────────────────────────────────────────────

let reconcileInterval: NodeJS.Timeout | null = null;
let runInFlight = false;

/**
 * Default RPC lookup implementation using sorobanService.
 * Imported lazily to avoid circular dependency at module load time.
 */
async function defaultRpcLookup(txHash: string): Promise<RpcLookupResult> {
  const { sorobanService } = await import('./sorobanService.js');
  try {
    const result = await sorobanService.getTransactionStatus(txHash);
    if (!result) {
      return { found: false, status: 'NOT_FOUND' };
    }
    return {
      found: true,
      status: result.status === 'SUCCESS' ? 'SUCCESS' : 'FAILED',
      ledger: result.ledger,
      resultXdr: result.resultXdr,
      errorDetail: result.errorDetail,
    };
  } catch (err) {
    throw err;
  }
}

export function startOrphanedTxReconciler(overrideRpcLookup?: RpcLookupFn): void {
  if (reconcileInterval) {
    logger.withContext().warn('orphaned_tx_reconciler: already running');
    return;
  }

  const intervalMs = getIntervalMs();
  const rpcLookup = overrideRpcLookup ?? defaultRpcLookup;

  logger.withContext().info('orphaned_tx_reconciler: starting', { intervalMs });

  reconcileInterval = setInterval(() => {
    if (runInFlight) return;
    runInFlight = true;

    const startedAt = Date.now();
    void orphanedTxReconciler
      .run(rpcLookup)
      .then((result) => {
        if (result.processed > 0 || result.detected > 0) {
          logger.withContext().info('orphaned_tx_reconciler.interval_pass', {
            ...result,
            durationMs: Date.now() - startedAt,
          });
        }
      })
      .catch((err) => {
        logger.withContext().error('orphaned_tx_reconciler.interval_error', { error: err });
      })
      .finally(() => {
        runInFlight = false;
      });
  }, intervalMs);

  reconcileInterval.unref();
}

export function stopOrphanedTxReconciler(): void {
  if (reconcileInterval) {
    clearInterval(reconcileInterval);
    reconcileInterval = null;
    logger.withContext().info('orphaned_tx_reconciler: stopped');
  }
}

export function isOrphanedTxReconcilerRunning(): boolean {
  return reconcileInterval !== null;
}
