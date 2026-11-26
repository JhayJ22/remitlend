import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../errors/AppError.js';
import { ErrorCode } from '../errors/errorCodes.js';
import { loanDisbursementService } from '../services/loanDisbursementService.js';
import { invalidateOnLoanMutation, invalidateOnUnscopedLoanWrite } from '../utils/cacheKeys.js';
import logger from '../utils/logger.js';

/**
 * POST /api/loans/:loanId/disburse
 *
 * Submits a signed `approve_loan` (disbursement) transaction with durable
 * idempotency. A replay with the same Idempotency-Key resolves the existing
 * submission by polling the chain instead of submitting again (#756).
 */
export const disburseLoan = asyncHandler(async (req: Request, res: Response) => {
  const loanId = Number(req.params.loanId);
  const { signedTxXdr } = req.body as { signedTxXdr?: string };
  const idempotencyKey = req.header('Idempotency-Key');

  if (!Number.isInteger(loanId) || loanId <= 0) {
    throw AppError.badRequest('Invalid loanId', ErrorCode.VALIDATION_ERROR, 'loanId');
  }
  if (!signedTxXdr) {
    throw AppError.badRequest('signedTxXdr is required', ErrorCode.MISSING_FIELD, 'signedTxXdr');
  }
  if (!idempotencyKey) {
    throw AppError.badRequest(
      'Idempotency-Key header is required for loan disbursement',
      ErrorCode.VALIDATION_ERROR,
      'Idempotency-Key',
    );
  }

  const submittedBy = (req as Request & { user?: { publicKey?: string } }).user?.publicKey ?? null;
  const result = await loanDisbursementService.submitLoanDisbursement({
    idempotencyKey,
    signedTxXdr,
    loanId,
    submittedBy: submittedBy ?? 'system',
  });

  logger.withContext().info('Loan disbursement submitted', {
    loanId,
    txHash: result.txHash,
    status: result.status,
    replayed: result.replayed,
    submittedBy,
  });

  if (submittedBy) {
    await invalidateOnLoanMutation(submittedBy);
  } else {
    await invalidateOnUnscopedLoanWrite();
  }

  res.set('X-Idempotent-Replayed', String(result.replayed));
  res.json({
    success: true,
    txHash: result.txHash,
    status: result.status,
    ...(result.resultXdr ? { resultXdr: result.resultXdr } : {}),
  });
});
