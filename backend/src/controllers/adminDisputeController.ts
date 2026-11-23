import { query } from '../db/connection.js';
import { AppError } from '../errors/AppError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { notificationService, type NotificationType } from '../services/notificationService.js';
import {
  assertDisputeTransition,
  recordDisputeTransition,
} from '../services/disputeStateMachine.js';
import { updateUserScoresBulk } from '../services/scoresService.js';
import { sorobanService } from '../services/sorobanService.js';
import { encodeCursor, decodeCursor, parseKeysetParams } from '../utils/pagination.js';

/**
 * List all loan disputes for admin review with cursor-based pagination.
 * Defaults to "open" status, orders newest-first by created_at.
 */
export const listLoanDisputes = asyncHandler(async (req, res) => {
  const snapshotSeq = typeof req.query.snapshot_seq === 'string' ? req.query.snapshot_seq : null;
  const cursorStr = typeof req.query.cursor === 'string' ? req.query.cursor : null;
  const limitParam = typeof req.query.limit === 'string' ? req.query.limit : null;
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;

  const {
    snapshotSeq: parsedSnapshotSeq,
    cursor: parsedCursor,
    limit,
  } = parseKeysetParams(snapshotSeq, cursorStr, limitParam);

  const statusFilter = status ?? 'open';

  if (
    statusFilter !== 'open' &&
    statusFilter !== 'resolved' &&
    statusFilter !== 'under_review' &&
    statusFilter !== 'dismissed' &&
    statusFilter !== 'rejected' &&
    statusFilter !== 'all'
  ) {
    throw AppError.badRequest('Invalid status filter');
  }

  // Decode cursor if provided
  let decodedCursor = null;
  if (parsedCursor) {
    decodedCursor = decodeCursor(parsedCursor);
  }

  // Pin snapshot on first request or use provided one
  let actualSnapshotSeq = parsedSnapshotSeq;
  if (actualSnapshotSeq === BigInt(0)) {
    // First page: pin the current max seq
    const maxSeqResult = await query('SELECT MAX(seq) as max_seq FROM loan_disputes', []);
    actualSnapshotSeq = BigInt(maxSeqResult.rows[0]?.max_seq ?? 0);
  }

  const params: unknown[] = [];
  let whereClause = '';

  // Status filter ('rejected' is a legacy alias of 'dismissed')
  if (statusFilter !== 'all') {
    params.push(statusFilter === 'rejected' ? 'dismissed' : statusFilter);
    whereClause = `WHERE status = $${params.length}`;
  }

  // Snapshot constraint
  params.push(actualSnapshotSeq.toString());
  const snapshotClause = `seq <= $${params.length}`;
  whereClause += whereClause.includes('WHERE')
    ? ` AND ${snapshotClause}`
    : ` WHERE ${snapshotClause}`;

  // Keyset constraint
  if (decodedCursor) {
    params.push(decodedCursor.createdAt.toISOString());
    params.push(decodedCursor.createdAt.toISOString());
    params.push(decodedCursor.seq.toString());
    const keysetClause = `(created_at < $${params.length - 2} OR (created_at = $${params.length - 1} AND seq < $${params.length}))`;
    whereClause += ` AND ${keysetClause}`;
  }

  params.push(limit + 1);

  const result = await query(
    `SELECT * FROM loan_disputes${whereClause} ORDER BY created_at DESC, seq DESC LIMIT $${params.length}`,
    params,
  );

  const rows = result.rows;
  const hasNext = rows.length > limit;
  const disputes = hasNext ? rows.slice(0, limit) : rows;

  let nextCursor: string | null = null;
  if (hasNext && disputes.length > 0) {
    const lastDispute = disputes[disputes.length - 1];
    nextCursor = encodeCursor(new Date(lastDispute.created_at), BigInt(lastDispute.seq));
  }

  // Count total at snapshot
  const countParams: unknown[] = [];
  let countWhereClause = '';

  if (statusFilter !== 'all') {
    countParams.push(statusFilter === 'rejected' ? 'dismissed' : statusFilter);
    countWhereClause = `WHERE status = $${countParams.length}`;
  }

  countParams.push(actualSnapshotSeq.toString());
  const countSnapshotClause = `seq <= $${countParams.length}`;
  countWhereClause += countWhereClause.includes('WHERE')
    ? ` AND ${countSnapshotClause}`
    : ` WHERE ${countSnapshotClause}`;

  const totalResult = await query(
    `SELECT COUNT(*) as count FROM loan_disputes ${countWhereClause}`,
    countParams,
  );
  const totalAtSnapshot = Number.parseInt(totalResult.rows[0].count, 10);

  res.json({
    success: true,
    data: {
      items: disputes,
    },
    page: {
      next_cursor: nextCursor,
      snapshot_seq: actualSnapshotSeq.toString(),
      total_at_snapshot: totalAtSnapshot,
      limit,
    },
  });
});

/**
 * Get a single dispute with its associated loan
 */
export const getLoanDispute = asyncHandler(async (req, res) => {
  const { disputeId } = req.params;
  const disputeResult = await query(
    `SELECT d.*, l.* AS loan FROM loan_disputes d JOIN loans l ON l.id = d.loan_id WHERE d.id = $1`,
    [disputeId],
  );

  if (disputeResult.rows.length === 0) {
    throw AppError.notFound('Dispute not found');
  }

  res.json({ success: true, dispute: disputeResult.rows[0] });
});

const adminActor = (req: { user?: { publicKey?: string } }): string =>
  req.user?.publicKey ?? 'admin-api-key';

async function loadDispute(disputeId: string | string[] | undefined) {
  const r = await query(`SELECT * FROM loan_disputes WHERE id = $1`, [disputeId]);
  if (r.rows.length === 0) throw AppError.notFound('Dispute not found');
  return r.rows[0];
}

async function notifyBorrower(
  dispute: any,
  title: string,
  message: string,
  type: NotificationType,
) {
  try {
    await notificationService.createNotification({
      userId: dispute.borrower,
      type,
      title,
      message,
      loanId: dispute.loan_id,
    });
  } catch {
    // notification failures must not fail the transition
  }
}

/**
 * Admin moves an open dispute to under_review.
 * POST /admin/disputes/:disputeId/review
 */
export const reviewLoanDispute = asyncHandler(async (req, res) => {
  const { note } = (req.body ?? {}) as { note?: string };
  const dispute = await loadDispute(req.params.disputeId);
  assertDisputeTransition(dispute.status, 'under_review');

  await query(`UPDATE loan_disputes SET status = 'under_review', reviewed_by = $1 WHERE id = $2`, [
    adminActor(req),
    dispute.id,
  ]);
  await recordDisputeTransition({
    actor: adminActor(req),
    disputeId: dispute.id,
    from: dispute.status,
    to: 'under_review',
    note,
  });
  res.json({ success: true, message: 'Dispute moved to under review.' });
});

/**
 * Admin resolves a dispute under review: confirm or reverse default.
 * POST /admin/loan-disputes/:disputeId/resolve
 * Body: { action, resolution, adminNote?, correctedRemittanceData? }
 */
export const resolveLoanDispute = asyncHandler(async (req, res) => {
  const { action, resolution, adminNote, correctedRemittanceData } = req.body as {
    action: string;
    resolution: string;
    adminNote?: string;
    correctedRemittanceData?: Record<string, unknown>;
  };

  if (!['confirm', 'reverse'].includes(action)) {
    throw AppError.badRequest('Action must be confirm or reverse');
  }
  if (!resolution || resolution.length < 5) {
    throw AppError.badRequest('Resolution reason required');
  }

  const dispute = await loadDispute(req.params.disputeId);
  assertDisputeTransition(dispute.status, 'resolved');

  await query(
    `UPDATE loan_disputes SET status = 'resolved', resolution = $1, admin_note = $2,
       corrected_remittance_data = $3, resolved_at = NOW() WHERE id = $4`,
    [
      resolution,
      adminNote || null,
      correctedRemittanceData ? JSON.stringify(correctedRemittanceData) : null,
      dispute.id,
    ],
  );

  await query(
    `INSERT INTO contract_events (loan_id, address, event_type, amount, ledger, ledger_closed_at) VALUES ($1, $2, $3, NULL, NULL, NOW())`,
    [
      dispute.loan_id,
      dispute.borrower,
      action === 'confirm' ? 'DefaultConfirmed' : 'DefaultReversed',
    ],
  );

  await recordDisputeTransition({
    actor: adminActor(req),
    disputeId: dispute.id,
    from: dispute.status,
    to: 'resolved',
    note: adminNote ?? resolution,
  });

  // Score recomputation: a reversed default undoes the default penalty.
  if (action === 'reverse') {
    const { defaultPenalty } = sorobanService.getScoreConfig();
    await updateUserScoresBulk(new Map([[dispute.borrower, defaultPenalty]]));
  }

  await notifyBorrower(
    dispute,
    'Dispute resolved',
    `Your dispute for loan ${dispute.loan_id} has been resolved: ${resolution}`,
    (action === 'reverse' ? 'repayment_confirmed' : 'loan_defaulted') as NotificationType,
  );

  res.json({ success: true, message: 'Dispute resolved.' });
});

/**
 * Admin dismisses a dispute under review (keeps default status).
 * POST /admin/disputes/:disputeId/reject
 */
export const rejectLoanDispute = asyncHandler(async (req, res) => {
  const { admin_note } = (req.body ?? {}) as { admin_note?: string };
  const dispute = await loadDispute(req.params.disputeId);
  assertDisputeTransition(dispute.status, 'dismissed');

  await query(
    `UPDATE loan_disputes SET status = 'dismissed', resolution = $1, admin_note = $2, resolved_at = NOW() WHERE id = $3`,
    [admin_note ?? 'dismissed by admin', admin_note ?? null, dispute.id],
  );
  await recordDisputeTransition({
    actor: adminActor(req),
    disputeId: dispute.id,
    from: dispute.status,
    to: 'dismissed',
    note: admin_note,
  });

  const msg = `Your dispute for loan ${dispute.loan_id} was dismissed by admin.`;
  await notifyBorrower(
    dispute,
    'Dispute dismissed',
    admin_note ? `${msg} Note: ${admin_note}` : msg,
    'loan_defaulted' as NotificationType,
  );

  res.json({ success: true, message: 'Dispute dismissed.' });
});
