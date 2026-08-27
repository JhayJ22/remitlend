import type { Request, Response, NextFunction } from 'express';
import { query } from '../db/connection.js';
import { withStellarAndDbTransaction } from '../db/transaction.js';
import { AppError } from '../errors/AppError.js';
import { ErrorCode } from '../errors/errorCodes.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sorobanService } from '../services/sorobanService.js';
import { rejectLoanSchema } from '../schemas/loanSchemas.js';
import logger from '../utils/logger.js';
import { emitLoanStateEvent } from '../services/loanStateEventStore.js';

// ─── Loan lifecycle / test-dev helpers (split from loanController, issue #41) ──

/**
 * POST /api/loans (TEST/DEV ONLY)
 * Creates a loan directly for test setup.
 */
export const createTestLoan = asyncHandler(
  async (req: Request, res: Response, _next: NextFunction) => {
    const { amount, term } = req.body;
    const borrower = req.user?.publicKey || 'test-borrower';

    if (!amount || !term) {
      res.status(400).json({ success: false, message: 'amount and term required' });
      return;
    }

    const loanResult = await query(
      `INSERT INTO contract_events (address, event_type, amount, ledger, ledger_closed_at) VALUES ($1, 'LoanRequested', $2, NULL, NOW()) RETURNING loan_id`,
      [borrower, amount],
    );
    const loanId = loanResult.rows[0].loan_id;

    await query(
      `INSERT INTO contract_events (loan_id, address, event_type, amount, interest_rate_bps, term_ledgers, ledger, ledger_closed_at) VALUES ($1, $2, 'LoanApproved', $3, 1200, $4, NULL, NOW())`,
      [loanId, borrower, amount, term],
    );

    // Issue #75: append domain events for the synthetic loan lifecycle.
    await emitLoanStateEvent({
      loanId: Number(loanId),
      eventType: 'LoanRequested',
      payload: { amount, borrower },
      actor: borrower,
    });
    await emitLoanStateEvent({
      loanId: Number(loanId),
      eventType: 'LoanApproved',
      payload: { amount, interestRateBps: 1200, termLedgers: term, borrower },
      actor: borrower,
    });

    res.json({
      success: true,
      id: loanId,
      loan: { id: loanId, amount, term, borrower },
    });
  },
);

export const buildCancelLoanTx = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { loanId } = req.params;

    const borrower = (req as unknown as { user?: { publicKey: string } }).user?.publicKey as string;

    const result = await query('SELECT * FROM loans WHERE id = $1', [loanId]);
    const loan = result.rows[0] as Record<string, unknown> | undefined;

    if (!loan) {
      return res.status(404).json({
        message: 'Loan not found',
      });
    }

    if (!['PENDING', 'OPEN'].includes(loan.status as string)) {
      return res.status(400).json({
        message: 'Loan cannot be cancelled',
      });
    }

    const transaction = await sorobanService.buildCancelLoanTx(borrower, loanId as string);

    return res.json({
      success: true,
      transaction,
    });
  } catch (error) {
    next(error);
    return;
  }
};

export const buildRejectLoanTx = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { loanId } = req.params;

    const { reason } = rejectLoanSchema.parse(req.body);

    const result = await query('SELECT * FROM loans WHERE id = $1', [loanId]);
    const loan = result.rows[0] as Record<string, unknown> | undefined;

    if (!loan) {
      return res.status(404).json({
        message: 'Loan not found',
      });
    }

    if (loan.status !== 'PENDING') {
      return res.status(400).json({
        message: 'Loan cannot be rejected',
      });
    }

    const transaction = await sorobanService.buildRejectLoanTx(
      req.user!.publicKey,
      loanId as string,
      reason,
    );

    return res.json({
      success: true,
      transaction,
    });
  } catch (error) {
    next(error);
    return;
  }
};

/**
 * POST /api/loans/:loanId/mark-defaulted (TEST/DEV ONLY)
 * Helper endpoint to mark a loan as defaulted for test setup.
 */
export const markLoanDefaulted = asyncHandler(async (req: Request, res: Response) => {
  const loanId = req.params.loanId as string;
  const borrower = req.body.borrower || req.user?.publicKey || null;

  const loanResult = await query(`SELECT loan_id FROM contract_events WHERE loan_id = $1 LIMIT 1`, [
    loanId,
  ]);
  if (loanResult.rows.length === 0) {
    throw AppError.badRequest('Loan does not exist');
  }

  await query(
    `INSERT INTO contract_events (loan_id, address, event_type, amount, ledger, ledger_closed_at) VALUES ($1, $2, 'LoanDefaulted', NULL, NULL, NOW())`,
    [loanId, borrower],
  );

  // Issue #75: append a domain event so the defaulted state is reconstructable.
  await emitLoanStateEvent({
    loanId: Number(loanId),
    eventType: 'LoanDefaulted',
    payload: { borrower },
    actor: borrower,
  });

  res.json({
    success: true,
    message: 'Loan marked as defaulted for test setup.',
  });
});

export const submitTransaction = asyncHandler(async (req: Request, res: Response) => {
  const { signedTxXdr } = req.body as { signedTxXdr: string };

  if (!signedTxXdr) {
    throw AppError.badRequest('signedTxXdr is required', ErrorCode.MISSING_FIELD, 'signedTxXdr');
  }

  // Use transaction wrapper for consistency with multi-step operations
  const result = await withStellarAndDbTransaction(
    // Stellar operation
    async () => {
      return await sorobanService.submitSignedTx(signedTxXdr);
    },
    // Database operations (currently none, but structured for future use)
    async (stellarResult: unknown, client) => {
      const sr = stellarResult as { txHash: string; status: string };
      await client.query(
        `INSERT INTO transaction_submissions (tx_hash, status, submitted_at, submitted_by)
           VALUES ($1, $2, NOW(), $3)
           ON CONFLICT (tx_hash) DO UPDATE SET
             status = EXCLUDED.status,
             submitted_at = EXCLUDED.submitted_at`,
        [sr.txHash, sr.status, req.user?.publicKey || null],
      );

      logger.withContext().info('Transaction submission recorded', {
        txHash: sr.txHash,
        status: sr.status,
        submittedBy: req.user?.publicKey,
      });

      return { recorded: true };
    },
  );

  const sr = result.stellarResult as {
    txHash: string;
    status: string;
    resultXdr?: string;
  };

  logger.withContext().info('Transaction submitted successfully', {
    txHash: sr.txHash,
    status: sr.status,
  });

  res.json({
    success: true,
    txHash: sr.txHash,
    status: sr.status,
    ...(sr.resultXdr ? { resultXdr: sr.resultXdr } : {}),
  });
});
