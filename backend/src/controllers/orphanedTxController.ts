/**
 * Controller for orphaned transaction reconciliation endpoints (issue #858).
 *
 * Endpoints:
 *   GET  /api/v1/transactions/:txHash/reconciliation
 *       Returns the reconciliation record for a specific tx_hash.
 *       Auth: JWT (must be the original submitter) or admin:reconciliation API key.
 *
 *   GET  /api/v1/admin/transactions/reconciliation
 *       Lists all reconciliation rows with optional state filter + cursor pagination.
 *       Auth: admin:reconciliation API key only.
 *
 *   POST /api/v1/transactions/:txHash/resubmit
 *       Approves resubmission of an orphaned transaction. Blocked in every
 *       state except `orphaned`. The caller supplies the new tx_hash of the
 *       re-signed transaction; this service only records the approval.
 *       Auth: JWT (original submitter) or admin:reconciliation API key.
 *
 *   POST /api/v1/admin/transactions/reconciliation/:id/resolve
 *       Manually resolves a reconciliation row. Requires a resolution note.
 *       Auth: admin:reconciliation API key only.
 */

import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../errors/AppError.js';
import { ErrorCode } from '../errors/errorCodes.js';
import { query } from '../db/connection.js';
import {
  getReconciliationByTxHash,
  getReconciliationById,
  approveResubmit,
  resolveReconciliation,
  listReconciliations,
  type OrphanedTxState,
} from '../services/orphanedTxReconciler.js';

// ── Helpers ───────────────────────────────────────────────────────────────

function parseLimit(value: unknown, max = 200, def = 50): number {
  if (typeof value !== 'string') return def;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : def;
}

function parseCursor(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function isAdminKey(req: Request): boolean {
  // The auth middleware attaches this after requireApiKey('admin:reconciliation').
  return !!(req as Request & { apiKeyScope?: string }).apiKeyScope;
}

/** Convert a service-layer error (plain Error with statusCode) to AppError. */
function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof Error && 'statusCode' in err) {
    const e = err as Error & { statusCode: number; errorCode?: string };
    const code = (e.errorCode as ErrorCode | undefined) ?? ErrorCode.INTERNAL_ERROR;
    return new AppError(e.message, e.statusCode, true, code);
  }
  return AppError.internal('Unexpected error');
}

// ── Controllers ───────────────────────────────────────────────────────────

/**
 * GET /api/v1/transactions/:txHash/reconciliation
 *
 * Returns the reconciliation record for the given tx_hash. Callers must
 * either own the submission (JWT, submitted_by == publicKey) or present an
 * admin:reconciliation API key.
 *
 * @openapi
 * /api/v1/transactions/{txHash}/reconciliation:
 *   get:
 *     summary: Get reconciliation status for a transaction
 *     description: >
 *       Returns the orphaned-transaction reconciliation record for a given
 *       tx_hash. The record is only present for submissions that were detected
 *       as potentially orphaned. Returns 404 when no record exists (the
 *       transaction was never classified as orphaned).
 *     tags: [Transactions]
 *     security:
 *       - bearerAuth: []
 *       - apiKey: []
 *     parameters:
 *       - in: path
 *         name: txHash
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Reconciliation record
 *       404:
 *         description: No reconciliation record found for this tx_hash
 */
export const getTransactionReconciliation = asyncHandler(
  async (req: Request, res: Response) => {
    const { txHash } = req.params;
    if (typeof txHash !== 'string' || txHash.trim().length === 0) {
      throw AppError.badRequest('txHash path parameter is required');
    }

    // Fetch the base submission to verify ownership.
    const submissionResult = await query(
      `SELECT id, submitted_by, tx_hash, status, submitted_at,
              transaction_type, reconciliation_state
       FROM transaction_submissions WHERE tx_hash = $1 LIMIT 1`,
      [txHash],
    );
    const submission = submissionResult.rows[0] as
      | {
          id: number;
          submitted_by: string | null;
          tx_hash: string;
          status: string;
          submitted_at: string;
          transaction_type: string;
          reconciliation_state: string | null;
        }
      | undefined;

    if (!submission) {
      throw AppError.notFound('Transaction not found', ErrorCode.NOT_FOUND);
    }

    // Authorization: JWT user must own the submission, or caller is admin.
    if (!isAdminKey(req)) {
      const publicKey = req.user?.publicKey;
      if (!publicKey) {
        throw AppError.unauthorized('Authentication required');
      }
      if (submission.submitted_by && submission.submitted_by !== publicKey) {
        throw AppError.forbidden('You do not have access to this transaction');
      }
    }

    const reconciliation = await getReconciliationByTxHash(txHash);

    res.json({
      success: true,
      data: {
        submission: {
          id: submission.id,
          txHash: submission.tx_hash,
          status: submission.status,
          submittedAt: submission.submitted_at,
          transactionType: submission.transaction_type,
          reconciliationState: submission.reconciliation_state,
        },
        reconciliation: reconciliation ?? null,
      },
    });
  },
);

/**
 * GET /api/v1/admin/transactions/reconciliation
 *
 * @openapi
 * /api/v1/admin/transactions/reconciliation:
 *   get:
 *     summary: List orphaned transaction reconciliation records
 *     tags: [Admin]
 *     security:
 *       - apiKey: []
 *     parameters:
 *       - in: query
 *         name: state
 *         schema:
 *           type: string
 *           enum: [pending_check, finality_pending, confirmed, failed_on_chain,
 *                  orphaned, resubmitted, resolved]
 *       - in: query
 *         name: limit
 *         schema: { type: integer, maximum: 200 }
 *       - in: query
 *         name: cursor
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Paginated list of reconciliation records
 */
export const listTransactionReconciliations = asyncHandler(
  async (req: Request, res: Response) => {
    const validStates: OrphanedTxState[] = [
      'pending_check',
      'finality_pending',
      'confirmed',
      'failed_on_chain',
      'orphaned',
      'resubmitted',
      'resolved',
    ];

    const rawState = req.query.state;
    const state =
      typeof rawState === 'string' && validStates.includes(rawState as OrphanedTxState)
        ? (rawState as OrphanedTxState)
        : undefined;

    const limit = parseLimit(req.query.limit);
    const cursor = parseCursor(req.query.cursor);

    const rows = await listReconciliations({ state, limit, cursor });
    const hasNext = rows.length === limit;
    const nextCursor = hasNext ? String(rows[rows.length - 1]?.id) : null;

    res.json({
      success: true,
      data: rows,
      page_info: {
        limit,
        count: rows.length,
        next_cursor: nextCursor,
        has_next: hasNext,
      },
    });
  },
);

/**
 * POST /api/v1/transactions/:txHash/resubmit
 *
 * Records approval for resubmitting an orphaned transaction. The caller
 * supplies the new signed tx_hash; actual resubmission to the RPC is
 * the caller's responsibility (this endpoint only tracks the intent).
 *
 * @openapi
 * /api/v1/transactions/{txHash}/resubmit:
 *   post:
 *     summary: Approve resubmission of an orphaned transaction
 *     description: >
 *       Marks an orphaned transaction as approved for resubmission.
 *       Blocked when the transaction is in `finality_pending`, `confirmed`,
 *       `failed_on_chain`, `resubmitted`, or `resolved` state to prevent
 *       double-execution.
 *     tags: [Transactions]
 *     security:
 *       - bearerAuth: []
 *       - apiKey: []
 *     parameters:
 *       - in: path
 *         name: txHash
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [newTxHash]
 *             properties:
 *               newTxHash:
 *                 type: string
 *                 description: The tx_hash of the re-signed transaction
 *     responses:
 *       200:
 *         description: Resubmission approved
 *       409:
 *         description: Resubmission blocked (finality_pending or terminal state)
 */
export const resubmitOrphanedTransaction = asyncHandler(
  async (req: Request, res: Response) => {
    const { txHash } = req.params;
    if (typeof txHash !== 'string' || txHash.trim().length === 0) {
      throw AppError.badRequest('txHash path parameter is required');
    }

    const body = req.body as { newTxHash?: unknown } | undefined;
    const newTxHash = typeof body?.newTxHash === 'string' ? body.newTxHash.trim() : '';
    if (!newTxHash) {
      throw AppError.badRequest('newTxHash is required in the request body', ErrorCode.MISSING_FIELD);
    }

    // Look up the reconciliation record.
    const reconciliation = await getReconciliationByTxHash(txHash);
    if (!reconciliation) {
      throw AppError.notFound(
        'No reconciliation record found for this transaction. ' +
          'The transaction may not have been classified as orphaned yet.',
        ErrorCode.NOT_FOUND,
      );
    }

    // Authorization: JWT user must own the submission, or caller is admin.
    let approvedBy: string;
    if (isAdminKey(req)) {
      approvedBy = `admin_key`;
    } else {
      const publicKey = req.user?.publicKey;
      if (!publicKey) {
        throw AppError.unauthorized('Authentication required');
      }
      if (
        reconciliation.submittedBy &&
        reconciliation.submittedBy !== publicKey
      ) {
        throw AppError.forbidden('You do not have access to this transaction');
      }
      approvedBy = publicKey;
    }

    try {
      const updated = await approveResubmit({
        reconciliationId: reconciliation.id,
        approvedBy,
        newTxHash,
      });
      res.json({ success: true, data: updated });
    } catch (err) {
      throw toAppError(err);
    }
  },
);

/**
 * POST /api/v1/admin/transactions/reconciliation/:id/resolve
 *
 * @openapi
 * /api/v1/admin/transactions/reconciliation/{id}/resolve:
 *   post:
 *     summary: Manually resolve an orphaned transaction reconciliation record
 *     tags: [Admin]
 *     security:
 *       - apiKey: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [resolvedBy, resolutionNote]
 *             properties:
 *               resolvedBy:
 *                 type: string
 *               resolutionNote:
 *                 type: string
 *                 minLength: 10
 *     responses:
 *       200:
 *         description: Reconciliation record resolved
 *       400:
 *         description: Validation error (missing fields or note too short)
 *       404:
 *         description: Reconciliation record not found
 */
export const resolveOrphanedTransaction = asyncHandler(
  async (req: Request, res: Response) => {
    const rawId = req.params.id;
    const id = Number.parseInt(typeof rawId === 'string' ? rawId : '', 10);
    if (!Number.isFinite(id) || id <= 0) {
      throw AppError.badRequest('id path parameter must be a positive integer');
    }

    const body = req.body as { resolvedBy?: unknown; resolutionNote?: unknown } | undefined;
    const resolvedBy = typeof body?.resolvedBy === 'string' ? body.resolvedBy.trim() : '';
    const resolutionNote =
      typeof body?.resolutionNote === 'string' ? body.resolutionNote.trim() : '';

    if (!resolvedBy) {
      throw AppError.badRequest('resolvedBy is required', ErrorCode.MISSING_FIELD);
    }
    if (resolutionNote.length < 10) {
      throw AppError.badRequest(
        'resolutionNote must be at least 10 characters',
        ErrorCode.VALIDATION_ERROR,
      );
    }

    // Verify the row exists first to give a clear 404 before the service layer.
    const existing = await getReconciliationById(id);
    if (!existing) {
      throw AppError.notFound('Reconciliation record not found', ErrorCode.NOT_FOUND);
    }

    try {
      const updated = await resolveReconciliation({
        reconciliationId: id,
        resolvedBy,
        resolutionNote,
      });
      res.json({ success: true, data: updated });
    } catch (err) {
      throw toAppError(err);
    }
  },
);
