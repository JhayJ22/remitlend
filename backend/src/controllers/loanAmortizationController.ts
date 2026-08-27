import type { Request, Response, NextFunction } from 'express';
import { query } from '../db/connection.js';
import { AppError } from '../errors/AppError.js';
import { ErrorCode } from '../errors/errorCodes.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getLoanConfig } from '../config/loanConfig.js';
import {
  buildAmortizationSchedule,
  DEFAULT_TERM_LEDGERS,
  DEFAULT_INTEREST_RATE_BPS,
} from '../services/loanAmortizationService.js';

/**
 * POST /api/loans/amortization-preview
 * Preview an amortization schedule for a hypothetical loan.
 */
export const previewLoanAmortizationSchedule = asyncHandler(async (req: Request, res: Response) => {
  const { amount, termDays } = req.body as {
    amount: number;
    termDays: 30 | 60 | 90;
  };

  const loanConfig = getLoanConfig();
  const interestRateBps = Math.round(loanConfig.interestRatePercent * 100);
  const termLedgers = termDays * DEFAULT_TERM_LEDGERS;

  const amortization = buildAmortizationSchedule(amount, interestRateBps, termLedgers, new Date());

  res.json({
    success: true,
    amortization,
  });
});

/**
 * GET /api/loans/:loanId/amortization-schedule
 * Build the amortization schedule for an existing loan from its approved terms.
 */
export const getLoanAmortizationSchedule = asyncHandler(
  async (req: Request, res: Response, _next: NextFunction) => {
    const { loanId } = req.params;

    const eventsResult = await query(
      `SELECT id, event_type, amount, ledger, ledger_closed_at, interest_rate_bps, term_ledgers
         FROM contract_events
         WHERE loan_id = $1
         ORDER BY ledger_closed_at ASC, ledger ASC, id ASC`,
      [loanId],
    );

    if (eventsResult.rows.length === 0) {
      throw AppError.notFound('Loan not found', ErrorCode.LOAN_NOT_FOUND, 'loanId');
    }

    const events = eventsResult.rows;
    const requestEvent = events.find(
      (event: Record<string, unknown>) => event.event_type === 'LoanRequested',
    );
    const approvalEvents = events.filter(
      (event: Record<string, unknown>) => event.event_type === 'LoanApproved',
    );
    const approvalEvent =
      approvalEvents.length > 0 ? approvalEvents[approvalEvents.length - 1] : undefined;

    if (!requestEvent || !approvalEvent || !requestEvent.amount) {
      throw AppError.notFound('Loan not fully approved', ErrorCode.LOAN_NOT_FOUND, 'loanId');
    }

    const principal = Number.parseFloat(String(requestEvent.amount));
    const interestRateBps = Number.parseInt(
      String(approvalEvent.interest_rate_bps ?? DEFAULT_INTEREST_RATE_BPS),
      10,
    );
    const termLedgers = Number.parseInt(
      String(approvalEvent.term_ledgers ?? DEFAULT_TERM_LEDGERS),
      10,
    );

    const approvedAt = approvalEvent.ledger_closed_at
      ? new Date(approvalEvent.ledger_closed_at)
      : new Date();

    const amortization = buildAmortizationSchedule(
      principal,
      interestRateBps,
      termLedgers,
      approvedAt,
    );

    res.json({
      success: true,
      loanId,
      amortization,
    });
  },
);
