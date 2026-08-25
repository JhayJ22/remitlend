import type { Request, Response, NextFunction } from 'express';
import { query } from '../db/connection.js';
import { AppError } from '../errors/AppError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import logger from '../utils/logger.js';
import { notificationService } from '../services/notificationService.js';
import { emitLoanStateEvent } from '../services/loanStateEventStore.js';

/**
 * POST /api/loans/:loanId/contest-default
 * Allows a borrower to contest a defaulted loan, moving it to disputed status
 * and logging the dispute. Extracted from loanController (issue #41).
 */
export const contestDefault = asyncHandler(
  async (req: Request, res: Response, _next: NextFunction) => {
    const loanId = req.params.loanId as string;
    const { reason } = req.body as { reason: string };
    const borrower = req.user?.publicKey;

    if (!reason || reason.trim().length < 5) {
      throw AppError.badRequest('A valid reason for contesting is required.');
    }
    if (!borrower) {
      throw AppError.unauthorized('Authentication required');
    }

    // Check loan exists and is defaulted
    const loanResult = await query(
      `SELECT loan_id FROM contract_events WHERE loan_id = $1 AND event_type = 'LoanDefaulted' LIMIT 1`,
      [loanId],
    );
    if (loanResult.rows.length === 0) {
      throw AppError.badRequest('Loan is not defaulted or does not exist');
    }

    // Insert dispute record and return disputeId
    const disputeResult = await query(
      `INSERT INTO loan_disputes (loan_id, borrower, reason, status) VALUES ($1, $2, $3, 'open') RETURNING id`,
      [loanId, borrower, reason],
    );

    await query(
      `INSERT INTO contract_events (loan_id, address, event_type, amount, ledger, ledger_closed_at) VALUES ($1, $2, 'LoanDisputed', NULL, NULL, NOW())`,
      [loanId, borrower],
    );

    // Issue #75: append a domain event so the loan's disputed state is
    // reconstructable by replaying the append-only event log.
    await emitLoanStateEvent({
      loanId: Number(loanId),
      eventType: 'LoanDisputed',
      payload: { reason },
      actor: borrower,
    });

    logger.withContext().info('Loan default contested', { loanId, borrower, reason });

    // Notify admins via email, SSE, and optional webhook
    await notificationService.notifyAdmins({
      title: 'Loan Default Contested',
      message: `Borrower ${borrower} has contested the default on loan #${loanId}. Reason: ${reason}`,
      loanId: Number(loanId),
    });

    res.json({
      success: true,
      disputeId: disputeResult.rows[0].id,
      message: 'Loan default contested. Admins will review your dispute.',
    });
  },
);
