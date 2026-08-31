import type { Request, Response } from 'express';
import { query } from '../db/connection.js';
import { AppError } from '../errors/AppError.js';
import { ErrorCode } from '../errors/errorCodes.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getLoanConfig } from '../config/loanConfig.js';
import { parseCursorQueryParams, createCursorPaginatedResponse } from '../utils/pagination.js';
import logger from '../utils/logger.js';
import {
  LEDGER_CLOSE_SECONDS,
  DEFAULT_TERM_LEDGERS,
  DEFAULT_INTEREST_RATE_BPS,
} from '../services/loanAmortizationService.js';

// Re-exported for backward compatibility (unit tests import roundToCents from
// here). The implementation lives in money/decimal.ts.
export { roundToCents } from '../money/decimal.js';

// ─── Thin re-exports of extracted modules (issue #41) ─────────────────────────
// The loan controller was split into focused modules so no controller file
// exceeds the 500-line guideline:
//   - loanDisputeController.ts   → dispute logic (contestDefault)
//   - loanAmortizationController.ts → amortization preview/schedule handlers
//   - loanTxController.ts        → unsigned-transaction builders + submit
export { contestDefault } from './loanDisputeController.js';
export {
  previewLoanAmortizationSchedule,
  getLoanAmortizationSchedule,
} from './loanAmortizationController.js';
export {
  createTestLoan,
  buildCancelLoanTx,
  buildRejectLoanTx,
  markLoanDefaulted,
  submitTransaction,
} from './loanLifecycleController.js';
export {
  requestLoan,
  repayLoan,
  depositCollateral,
  releaseCollateral,
  refinanceLoan,
  extendLoan,
  buildLiquidateLoan,
} from './loanTxController.js';

type BorrowerLoan = {
  loanId: number;
  principal: number;
  accruedInterest: number | null;
  totalRepaid: number;
  totalOwed: number | null;
  nextPaymentDeadline: string;
  status: 'active' | 'repaid' | 'defaulted' | 'pending_indexing';
  borrower: string;
  approvedAt: string | null;
  latestEventType?: string;
};

const getLatestLedger = async (): Promise<number> => {
  const result = await query(
    'SELECT last_indexed_ledger FROM indexer_state ORDER BY id DESC LIMIT 1',
    [],
  );

  return result.rows[0]?.last_indexed_ledger ?? 0;
};

/**
 * GET /api/loans/config
 */
export const getLoanConfigEndpoint = asyncHandler(async (_req: Request, res: Response) => {
  const loanConfig = getLoanConfig();

  res.json({
    success: true,
    data: {
      minScore: loanConfig.minScore,
      maxAmount: loanConfig.maxAmount,
      interestRatePercent: loanConfig.interestRatePercent,
      creditScoreThreshold: loanConfig.creditScoreThreshold,
    },
  });
});

/**
 * Get active loans for a borrower
 *
 * GET /api/loans/borrower/:borrower
 */
export const getBorrowerLoans = asyncHandler(async (req: Request, res: Response) => {
  const { borrower } = req.params;
  const { limit, cursor, status, dateRange, amountRange } = parseCursorQueryParams(req);

  // `from` and `to` are validated by the Zod middleware; merge into dateRange
  const fromParam = typeof req.query.from === 'string' ? new Date(req.query.from) : null;
  const toParam = typeof req.query.to === 'string' ? new Date(req.query.to) : null;
  const effectiveDateRange =
    fromParam !== null || toParam !== null
      ? {
          start: fromParam ?? new Date(0),
          end: toParam ?? new Date(),
        }
      : dateRange;

  const currentLedger = await getLatestLedger();

  const loansQuery = `
      WITH loan_summaries AS (
        SELECT
          loan_id,
          address,
          MAX(CASE WHEN event_type = 'LoanRequested' THEN amount END)::numeric as principal,
          MAX(CASE WHEN event_type = 'LoanApproved' THEN ledger_closed_at END) as approved_at,
          MAX(CASE WHEN event_type = 'LoanApproved' THEN ledger END) as approved_ledger,
          MAX(CASE WHEN event_type = 'LoanApproved' THEN interest_rate_bps END) as rate_bps,
          MAX(CASE WHEN event_type = 'LoanApproved' THEN term_ledgers END) as term_ledgers,
          SUM(CASE WHEN event_type = 'LoanRepaid' THEN amount::numeric ELSE 0 END) as total_repaid,
          MAX(CASE WHEN event_type = 'LoanDefaulted' THEN 1 ELSE 0 END) as is_defaulted,
          (
            ARRAY_AGG(
              event_type
              ORDER BY COALESCE(ledger, 0) DESC, ledger_closed_at DESC, id DESC
            )
          )[1] as latest_event_type
        FROM contract_events
        WHERE address = $1 AND loan_id IS NOT NULL
        GROUP BY loan_id, address
      ),
      loan_calculations AS (
        SELECT
          *,
          COALESCE(rate_bps, ${DEFAULT_INTEREST_RATE_BPS}) as effective_rate_bps,
          COALESCE(term_ledgers, ${DEFAULT_TERM_LEDGERS}) as effective_term_ledgers,
          COALESCE(approved_ledger, 0) as effective_approved_ledger
        FROM loan_summaries
      ),
      loan_fin AS (
        SELECT
          *,
          (principal * effective_rate_bps * GREATEST(0, $2 - effective_approved_ledger)) / (10000 * effective_term_ledgers) as accrued_interest
        FROM loan_calculations
      ),
      loan_final AS (
        SELECT
          *,
          (principal + accrued_interest - total_repaid) as total_owed,
          CASE 
            WHEN approved_at IS NOT NULL THEN (approved_at + (effective_term_ledgers * ${LEDGER_CLOSE_SECONDS} || ' seconds')::interval)
            ELSE NOW()
          END as next_payment_deadline,
          CASE 
            WHEN approved_ledger IS NULL OR approved_ledger = 0 OR $2 < approved_ledger THEN 'pending_indexing'
            WHEN is_defaulted = 1 THEN 'defaulted'
            WHEN (principal + accrued_interest - total_repaid) > 0.01 THEN 'active'
            ELSE 'repaid'
          END as status
        FROM loan_fin
      )
      SELECT *, COUNT(*) OVER() as full_count
      FROM loan_final
      WHERE ($3::text IS NULL OR status = $3)
        AND ($4::numeric IS NULL OR principal >= $4)
        AND ($5::numeric IS NULL OR principal <= $5)
        AND ($6::timestamp IS NULL OR approved_at >= $6)
        AND ($7::timestamp IS NULL OR approved_at <= $7)
        AND ($8::int IS NULL OR loan_id > $8)
      ORDER BY loan_id ASC
      LIMIT $9
    `;

  const cursorValue = cursor ? Number.parseInt(cursor, 10) : null;
  const queryParams = [
    borrower,
    currentLedger,
    status && status !== 'all' ? status : null,
    amountRange?.min ?? null,
    amountRange?.max ?? null,
    effectiveDateRange?.start ?? null,
    effectiveDateRange?.end ?? null,
    cursorValue,
    limit + 1,
  ];

  const result = await query(loansQuery, queryParams);

  const totalCount = result.rows.length > 0 ? Number.parseInt(result.rows[0].full_count, 10) : 0;

  const hasNext = result.rows.length > limit;
  const trimmedRows = hasNext ? result.rows.slice(0, limit) : result.rows;

  const loans: BorrowerLoan[] = trimmedRows.map((row: Record<string, unknown>) => {
    const isPending = row.status === 'pending_indexing';
    return {
      loanId: Number(row.loan_id),
      principal: Number.parseFloat((row.principal as string) || '0'),
      accruedInterest: isPending
        ? null
        : Number.parseFloat((row.accrued_interest as string) || '0'),
      totalRepaid: Number.parseFloat((row.total_repaid as string) || '0'),
      totalOwed: isPending ? null : Number.parseFloat((row.total_owed as string) || '0'),
      nextPaymentDeadline: new Date(row.next_payment_deadline as string).toISOString(),
      status: row.status as 'active' | 'repaid' | 'defaulted' | 'pending_indexing',
      borrower: row.address as string,
      approvedAt: row.approved_at ? new Date(row.approved_at as string).toISOString() : null,
      ...(typeof row.latest_event_type === 'string'
        ? { latestEventType: row.latest_event_type as string }
        : {}),
    };
  });

  const lastLoan = loans.length > 0 ? loans[loans.length - 1] : undefined;
  const nextCursor = hasNext && lastLoan ? String(lastLoan.loanId) : null;

  res.json(
    createCursorPaginatedResponse(
      {
        borrower,
        loans,
      },
      totalCount,
      limit,
      loans.length,
      nextCursor,
      Boolean(cursor),
    ),
  );
});

/**
 * Get detailed loan history and current stats
 *
 * GET /api/loans/:loanId
 */
export const getLoanDetails = asyncHandler(async (req: Request, res: Response) => {
  const { loanId } = req.params;

  const eventsResult = await query(
    `SELECT id, event_type, amount, ledger, ledger_closed_at, tx_hash, interest_rate_bps, term_ledgers
       FROM contract_events
       WHERE loan_id = $1
       ORDER BY ledger_closed_at ASC, ledger ASC, id ASC`,
    [loanId],
  );

  if (eventsResult.rows.length === 0) {
    throw AppError.notFound('Loan not found', ErrorCode.LOAN_NOT_FOUND, 'loanId');
  }

  const events = eventsResult.rows;
  const currentLedger = await getLatestLedger();
  const requestEvent = events.find(
    (event: Record<string, unknown>) => event.event_type === 'LoanRequested',
  );
  const approvalEvents = events.filter(
    (event: Record<string, unknown>) => event.event_type === 'LoanApproved',
  );
  // A re-indexed or re-emitted LoanApproved produces several rows for the same
  // on-chain event. Collapse them by transaction hash so downstream logic — and
  // the logs — only ever see one approval per transaction. This makes duplicate
  // handling idempotent instead of just noisy.
  const dedupedApprovalEvents = Array.from(
    new Map(
      approvalEvents.map((event: Record<string, unknown>) => [
        (event.tx_hash as string | null) ?? `${String(event.ledger)}:${String(event.id)}`,
        event,
      ]),
    ).values(),
  );
  // Only genuinely distinct approval transactions are worth a warning; a plain
  // duplicate from re-indexing is expected and handled silently above.
  if (dedupedApprovalEvents.length > 1) {
    logger.withContext().warn('Multiple distinct LoanApproved transactions for loan', {
      loanId,
      approvalTxCount: dedupedApprovalEvents.length,
    });
  }
  const approvalEvent =
    dedupedApprovalEvents.length > 0
      ? dedupedApprovalEvents[dedupedApprovalEvents.length - 1]
      : undefined;
  const repaymentEvents = events.filter(
    (event: Record<string, unknown>) => event.event_type === 'LoanRepaid',
  );

  const principal = Number.parseFloat(requestEvent?.amount || '0');
  const totalRepaid = repaymentEvents.reduce(
    (sum: number, event: Record<string, unknown>) =>
      sum + Number.parseFloat((event.amount as string) || '0'),
    0,
  );

  const rateBps = approvalEvent?.interest_rate_bps || DEFAULT_INTEREST_RATE_BPS;
  const termLedgers = approvalEvent?.term_ledgers || DEFAULT_TERM_LEDGERS;
  const approvedLedger = approvalEvent?.ledger || 0;

  // Check for open dispute
  const disputeResult = await query(
    `SELECT created_at FROM loan_disputes WHERE loan_id = $1 AND status = 'open' ORDER BY created_at ASC LIMIT 1`,
    [loanId],
  );
  let freezeLedger: number | null = null;
  if (disputeResult.rows.length > 0) {
    // Find the ledger closest to dispute creation
    const disputeCreatedAt = new Date(disputeResult.rows[0].created_at);
    // Find the ledger that closed just before or at disputeCreatedAt
    const ledgerResult = await query(
      `SELECT ledger, ledger_closed_at FROM contract_events WHERE loan_id = $1 AND ledger_closed_at <= $2 ORDER BY ledger_closed_at DESC LIMIT 1`,
      [loanId, disputeCreatedAt],
    );
    freezeLedger = ledgerResult.rows.length > 0 ? ledgerResult.rows[0].ledger : null;
  }

  let elapsedLedgers: number;
  if (freezeLedger !== null) {
    elapsedLedgers = Math.max(0, freezeLedger - approvedLedger);
  } else {
    elapsedLedgers = Math.max(0, currentLedger - approvedLedger);
  }

  const isDefaulted = events.some(
    (event: Record<string, unknown>) => event.event_type === 'LoanDefaulted',
  );

  const isPending = approvedLedger <= 0 || currentLedger < approvedLedger;

  const accruedInterest = isPending
    ? 0
    : (principal * rateBps * elapsedLedgers) / (10000 * termLedgers);
  const totalOwed = principal + accruedInterest - totalRepaid;

  res.json({
    success: true,
    loanId,
    summary: {
      principal,
      accruedInterest: isPending ? null : accruedInterest,
      totalRepaid,
      totalOwed: isPending ? null : totalOwed,
      interestRate: rateBps / 10000,
      termLedgers,
      elapsedLedgers,
      status: isPending
        ? 'pending_indexing'
        : isDefaulted
          ? 'defaulted'
          : totalOwed > 0.01
            ? 'active'
            : 'repaid',
      requestedAt: requestEvent?.ledger_closed_at,
      approvedAt: approvalEvent?.ledger_closed_at,
      events: events.map((event: Record<string, unknown>) => ({
        type: event.event_type,
        amount: event.amount,
        timestamp: event.ledger_closed_at,
        tx: event.tx_hash,
      })),
      disputeFrozen: freezeLedger !== null,
    },
  });
});
