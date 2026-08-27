import type { Request, Response } from 'express';
import { AppError } from '../errors/AppError.js';
import { ErrorCode } from '../errors/errorCodes.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sorobanService } from '../services/sorobanService.js';
import logger from '../utils/logger.js';
import { cacheService } from '../services/cacheService.js';
import { invalidateOnRepay, invalidateOnLoanRequest } from '../utils/cacheKeys.js';

export const requestLoan = asyncHandler(async (req: Request, res: Response) => {
  const { amount, borrowerPublicKey } = req.body as {
    amount: number;
    borrowerPublicKey: string;
  };

  if (borrowerPublicKey !== req.user?.publicKey) {
    throw AppError.forbidden(
      'borrowerPublicKey must match your authenticated wallet',
      ErrorCode.BORROWER_MISMATCH,
    );
  }

  if (
    process.env.NODE_ENV !== 'test' &&
    'getPoolBalance' in sorobanService &&
    typeof (sorobanService as unknown as { getPoolBalance?: () => Promise<number> })
      .getPoolBalance === 'function'
  ) {
    const poolBalance = await (
      sorobanService as unknown as { getPoolBalance: () => Promise<number> }
    ).getPoolBalance();
    if (amount > poolBalance) {
      throw AppError.badRequest(
        'Insufficient pool liquidity to cover this loan',
        ErrorCode.INSUFFICIENT_BALANCE,
      );
    }
  }

  // Idempotency: return existing unsigned tx if recently built for this borrower/amount
  const cacheKey = `pending_loan_tx:${borrowerPublicKey}:${amount}`;
  const cachedTx = await cacheService.get<{
    unsignedTxXdr: string;
    networkPassphrase: string;
  }>(cacheKey);

  if (cachedTx) {
    logger.withContext().info('Returning cached unsigned loan request tx', {
      borrower: borrowerPublicKey,
      amount,
    });
    res.json({
      success: true,
      unsignedTxXdr: cachedTx.unsignedTxXdr,
      networkPassphrase: cachedTx.networkPassphrase,
    });
    return;
  }

  const result = await sorobanService.buildRequestLoanTx(borrowerPublicKey, amount);

  // Cache for 60 seconds to prevent sequence number collisions from rapid requests
  await cacheService.set(cacheKey, result, 60);

  // Invalidate stale read-cache keys now that a loan request has been built
  await invalidateOnLoanRequest(borrowerPublicKey);

  logger.withContext().info('Loan request transaction built', {
    borrower: borrowerPublicKey,
    amount,
  });

  res.json({
    success: true,
    unsignedTxXdr: result.unsignedTxXdr,
    networkPassphrase: result.networkPassphrase,
  });
  return;
});

export const repayLoan = asyncHandler(async (req: Request, res: Response) => {
  const loanId = req.params.loanId as string;
  const { amount, borrowerPublicKey } = req.body as {
    amount: number;
    borrowerPublicKey: string;
  };

  if (borrowerPublicKey !== req.user?.publicKey) {
    throw AppError.forbidden(
      'borrowerPublicKey must match your authenticated wallet',
      ErrorCode.BORROWER_MISMATCH,
    );
  }

  const loanIdNum = Number.parseInt(loanId, 10);
  if (!Number.isFinite(loanIdNum) || loanIdNum <= 0) {
    throw AppError.badRequest('Invalid loan ID', ErrorCode.INVALID_LOAN_ID, 'loanId');
  }

  // Idempotency: return existing unsigned tx if recently built for this borrower/loan/amount
  const cacheKey = `pending_repay_tx:${borrowerPublicKey}:${loanIdNum}:${amount}`;
  const cachedTx = await cacheService.get<{
    unsignedTxXdr: string;
    networkPassphrase: string;
  }>(cacheKey);

  if (cachedTx) {
    logger.withContext().info('Returning cached unsigned repay tx', {
      borrower: borrowerPublicKey,
      loanId: loanIdNum,
      amount,
    });
    res.json({
      success: true,
      loanId: loanIdNum,
      unsignedTxXdr: cachedTx.unsignedTxXdr,
      networkPassphrase: cachedTx.networkPassphrase,
    });
    return;
  }

  const result = await sorobanService.buildRepayTx(borrowerPublicKey, loanIdNum, amount);

  // Cache for 60 seconds
  await cacheService.set(cacheKey, result, 60);

  // Invalidate stale read-cache keys now that a repayment has been initiated
  await invalidateOnRepay(borrowerPublicKey, loanIdNum);

  logger.withContext().info('Repay transaction built', {
    borrower: borrowerPublicKey,
    loanId: loanIdNum,
    amount,
  });

  res.json({
    success: true,
    loanId: loanIdNum,
    unsignedTxXdr: result.unsignedTxXdr,
    networkPassphrase: result.networkPassphrase,
  });
  return;
});

export const depositCollateral = asyncHandler(async (req: Request, res: Response) => {
  const loanId = req.params.loanId as string;
  const { amount, borrowerPublicKey } = req.body as {
    amount: number;
    borrowerPublicKey: string;
  };

  if (borrowerPublicKey !== req.user?.publicKey) {
    throw AppError.forbidden(
      'borrowerPublicKey must match your authenticated wallet',
      ErrorCode.BORROWER_MISMATCH,
    );
  }

  const loanIdNum = Number.parseInt(loanId, 10);
  if (!Number.isFinite(loanIdNum) || loanIdNum <= 0) {
    throw AppError.badRequest('Invalid loan ID', ErrorCode.INVALID_LOAN_ID, 'loanId');
  }

  const cacheKey = `pending_deposit_collateral_tx:${borrowerPublicKey}:${loanIdNum}:${amount}`;
  const cachedTx = await cacheService.get<{
    unsignedTxXdr: string;
    networkPassphrase: string;
  }>(cacheKey);

  if (cachedTx) {
    logger.withContext().info('Returning cached unsigned deposit_collateral tx', {
      borrower: borrowerPublicKey,
      loanId: loanIdNum,
      amount,
    });
    res.json({
      success: true,
      loanId: loanIdNum,
      unsignedTxXdr: cachedTx.unsignedTxXdr,
      networkPassphrase: cachedTx.networkPassphrase,
    });
    return;
  }

  const result = await sorobanService.buildDepositCollateralTx(
    borrowerPublicKey,
    loanIdNum,
    amount,
  );

  await cacheService.set(cacheKey, result, 60);

  logger.withContext().info('Deposit collateral transaction built', {
    borrower: borrowerPublicKey,
    loanId: loanIdNum,
    amount,
  });

  res.json({
    success: true,
    loanId: loanIdNum,
    unsignedTxXdr: result.unsignedTxXdr,
    networkPassphrase: result.networkPassphrase,
  });
});

export const releaseCollateral = asyncHandler(async (req: Request, res: Response) => {
  const loanId = req.params.loanId as string;
  const { borrowerPublicKey } = req.body as {
    borrowerPublicKey: string;
  };

  if (borrowerPublicKey !== req.user?.publicKey) {
    throw AppError.forbidden(
      'borrowerPublicKey must match your authenticated wallet',
      ErrorCode.BORROWER_MISMATCH,
    );
  }

  const loanIdNum = Number.parseInt(loanId, 10);
  if (!Number.isFinite(loanIdNum) || loanIdNum <= 0) {
    throw AppError.badRequest('Invalid loan ID', ErrorCode.INVALID_LOAN_ID, 'loanId');
  }

  const cacheKey = `pending_release_collateral_tx:${borrowerPublicKey}:${loanIdNum}`;
  const cachedTx = await cacheService.get<{
    unsignedTxXdr: string;
    networkPassphrase: string;
  }>(cacheKey);

  if (cachedTx) {
    logger.withContext().info('Returning cached unsigned release_collateral tx', {
      borrower: borrowerPublicKey,
      loanId: loanIdNum,
    });
    res.json({
      success: true,
      loanId: loanIdNum,
      unsignedTxXdr: cachedTx.unsignedTxXdr,
      networkPassphrase: cachedTx.networkPassphrase,
    });
    return;
  }

  const result = await sorobanService.buildReleaseCollateralTx(borrowerPublicKey, loanIdNum);

  await cacheService.set(cacheKey, result, 60);

  logger.withContext().info('Release collateral transaction built', {
    borrower: borrowerPublicKey,
    loanId: loanIdNum,
  });

  res.json({
    success: true,
    loanId: loanIdNum,
    unsignedTxXdr: result.unsignedTxXdr,
    networkPassphrase: result.networkPassphrase,
  });
});

export const refinanceLoan = asyncHandler(async (req: Request, res: Response) => {
  const loanId = req.params.loanId as string;
  const { newAmount, newTerm, borrowerPublicKey } = req.body as {
    newAmount: number;
    newTerm: number;
    borrowerPublicKey: string;
  };

  if (borrowerPublicKey !== req.user?.publicKey) {
    throw AppError.forbidden(
      'borrowerPublicKey must match your authenticated wallet',
      ErrorCode.BORROWER_MISMATCH,
    );
  }

  const loanIdNum = Number.parseInt(loanId, 10);
  if (!Number.isFinite(loanIdNum) || loanIdNum <= 0) {
    throw AppError.badRequest('Invalid loan ID', ErrorCode.INVALID_LOAN_ID, 'loanId');
  }

  const cacheKey = `pending_refinance_tx:${borrowerPublicKey}:${loanIdNum}:${newAmount}:${newTerm}`;
  const cachedTx = await cacheService.get<{
    unsignedTxXdr: string;
    networkPassphrase: string;
  }>(cacheKey);

  if (cachedTx) {
    logger.withContext().info('Returning cached unsigned refinance tx', {
      borrower: borrowerPublicKey,
      loanId: loanIdNum,
      newAmount,
      newTerm,
    });
    res.json({
      success: true,
      loanId: loanIdNum,
      unsignedTxXdr: cachedTx.unsignedTxXdr,
      networkPassphrase: cachedTx.networkPassphrase,
    });
    return;
  }

  const result = await sorobanService.buildRefinanceLoanTx(
    borrowerPublicKey,
    loanIdNum,
    newAmount,
    newTerm,
  );

  await cacheService.set(cacheKey, result, 60);

  logger.withContext().info('Refinance loan transaction built', {
    borrower: borrowerPublicKey,
    loanId: loanIdNum,
    newAmount,
    newTerm,
  });

  res.json({
    success: true,
    loanId: loanIdNum,
    unsignedTxXdr: result.unsignedTxXdr,
    networkPassphrase: result.networkPassphrase,
  });
});

export const extendLoan = asyncHandler(async (req: Request, res: Response) => {
  const loanId = req.params.loanId as string;
  const { extraLedgers, borrowerPublicKey } = req.body as {
    extraLedgers: number;
    borrowerPublicKey: string;
  };

  if (borrowerPublicKey !== req.user?.publicKey) {
    throw AppError.forbidden(
      'borrowerPublicKey must match your authenticated wallet',
      ErrorCode.BORROWER_MISMATCH,
    );
  }

  const loanIdNum = Number.parseInt(loanId, 10);
  if (!Number.isFinite(loanIdNum) || loanIdNum <= 0) {
    throw AppError.badRequest('Invalid loan ID', ErrorCode.INVALID_LOAN_ID, 'loanId');
  }

  const cacheKey = `pending_extend_tx:${borrowerPublicKey}:${loanIdNum}:${extraLedgers}`;
  const cachedTx = await cacheService.get<{
    unsignedTxXdr: string;
    networkPassphrase: string;
  }>(cacheKey);

  if (cachedTx) {
    logger.withContext().info('Returning cached unsigned extend tx', {
      borrower: borrowerPublicKey,
      loanId: loanIdNum,
      extraLedgers,
    });
    res.json({
      success: true,
      loanId: loanIdNum,
      unsignedTxXdr: cachedTx.unsignedTxXdr,
      networkPassphrase: cachedTx.networkPassphrase,
    });
    return;
  }

  const result = await sorobanService.buildExtendLoanTx(borrowerPublicKey, loanIdNum, extraLedgers);

  await cacheService.set(cacheKey, result, 60);

  logger.withContext().info('Extend loan transaction built', {
    borrower: borrowerPublicKey,
    loanId: loanIdNum,
    extraLedgers,
  });

  res.json({
    success: true,
    loanId: loanIdNum,
    unsignedTxXdr: result.unsignedTxXdr,
    networkPassphrase: result.networkPassphrase,
  });
});

export const buildLiquidateLoan = asyncHandler(async (req: Request, res: Response) => {
  const loanId = req.params.loanId as string;
  const { liquidatorPublicKey } = req.body as {
    liquidatorPublicKey: string;
  };

  if (liquidatorPublicKey !== req.user?.publicKey) {
    throw AppError.forbidden(
      'liquidatorPublicKey must match your authenticated wallet',
      ErrorCode.ACCESS_DENIED,
    );
  }

  const loanIdNum = Number.parseInt(loanId, 10);
  if (!Number.isFinite(loanIdNum) || loanIdNum <= 0) {
    throw AppError.badRequest('Invalid loan ID', ErrorCode.INVALID_LOAN_ID, 'loanId');
  }

  const cacheKey = `pending_liquidate_tx:${liquidatorPublicKey}:${loanIdNum}`;
  const cachedTx = await cacheService.get<{
    unsignedTxXdr: string;
    networkPassphrase: string;
  }>(cacheKey);

  if (cachedTx) {
    logger.withContext().info('Returning cached unsigned liquidate tx', {
      liquidator: liquidatorPublicKey,
      loanId: loanIdNum,
    });
    res.json({
      success: true,
      loanId: loanIdNum,
      unsignedTxXdr: cachedTx.unsignedTxXdr,
      networkPassphrase: cachedTx.networkPassphrase,
    });
    return;
  }

  const result = await sorobanService.buildLiquidateTx(liquidatorPublicKey, loanIdNum);

  await cacheService.set(cacheKey, result, 60);

  logger.withContext().info('Liquidate loan transaction built', {
    liquidator: liquidatorPublicKey,
    loanId: loanIdNum,
  });

  res.json({
    success: true,
    loanId: loanIdNum,
    unsignedTxXdr: result.unsignedTxXdr,
    networkPassphrase: result.networkPassphrase,
  });
});
