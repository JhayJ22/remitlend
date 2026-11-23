import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../errors/AppError.js';
import { ErrorCode } from '../errors/errorCodes.js';
import logger from '../utils/logger.js';
import { query } from '../db/connection.js';
import { getNetworkTelemetrySnapshot } from '../services/networkTelemetryService.js';
import {
  getNetworkFailoverStatus,
  listNetworkFailoverEvents,
} from '../services/networkFailoverService.js';
import { sorobanWriteQueue } from '../services/sorobanWriteQueue.js';

/**
 * Admin controllers for per-network transaction-submission telemetry,
 * bounded failover status, and dead-letter re-drive (#857).
 *
 * All routes are gated by `requireApiKey('admin:indexer')` (see adminRoutes):
 * these are operator-only operational surfaces, never borrower/lender
 * financial data. Responses never include secrets; RPC URLs are operational
 * identifiers and are safe to surface to operators.
 */

/** GET /admin/network-telemetry — throughput, latency, throttle, error, failover, queue, storm alert. */
export const getNetworkTelemetry = asyncHandler(async (_req: Request, res: Response) => {
  const [telemetry, failover] = await Promise.all([
    getNetworkTelemetrySnapshot(),
    Promise.resolve(getNetworkFailoverStatus()),
  ]);

  res.json({
    success: true,
    data: {
      telemetry,
      failover,
    },
  });
});

/** GET /admin/network-failover/events — recent failover / storm audit events. */
export const getNetworkFailoverEvents = asyncHandler(async (req: Request, res: Response) => {
  const limit = Number(req.query.limit);
  const events = await listNetworkFailoverEvents(
    Number.isInteger(limit) && limit > 0 ? limit : 50,
  );

  res.json({
    success: true,
    data: { events },
  });
});

/** GET /admin/network-failover/dead-letters — list dead-lettered writes (no signed payloads). */
export const listDeadLetterWrites = asyncHandler(async (req: Request, res: Response) => {
  const limit = Number(req.query.limit);
  const deadLetters = await sorobanWriteQueue.listDeadLetters(
    Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 50,
  );

  // Never expose the signed XDR to the UI; surface only operational metadata.
  const rows = deadLetters.map((w) => ({
    id: w.id,
    operation: w.operation,
    attempts: w.attempts,
    maxAttempts: w.maxAttempts,
    lastError: w.lastError,
    deadLetteredAt: w.deadLetteredAt,
    deadLetterReason: w.deadLetterReason,
  }));

  res.json({
    success: true,
    data: { deadLetters: rows },
  });
});

/** POST /admin/network-failover/dead-letters/:id/redrive — re-queue a dead-lettered write. */
export const redriveDeadLetterWrite = asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    throw AppError.badRequest('A positive integer dead-letter id is required', ErrorCode.VALIDATION_ERROR, 'id');
  }

  // Reject stale / invalid actions without partial side effects: only a row
  // that is currently dead-lettered may be re-driven, and we re-check under the
  // same statement so a concurrent redrive cannot double-apply.
  const existing = await query(
    `SELECT id, status, attempts, max_attempts, dead_lettered_at
       FROM soroban_write_queue
       WHERE id = $1 AND status = 'dead_lettered'`,
    [id],
  );
  const row = existing.rows[0] as { id: number; attempts: number; max_attempts: number } | undefined;
  if (!row) {
    throw AppError.notFound('Dead-lettered write not found', ErrorCode.NOT_FOUND, 'id');
  }

  await sorobanWriteQueue.redrive(id);

  logger.withContext({ module: 'network-telemetry' }).warn('Dead-lettered write re-driven', {
    id,
    previousAttempts: row.attempts,
    maxAttempts: row.max_attempts,
    reDrivenBy: (req as Request & { user?: { publicKey?: string } }).user?.publicKey ?? 'api-key',
  });

  res.json({
    success: true,
    data: { id, status: 'pending' },
  });
});
