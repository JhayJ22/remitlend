import type { Request, Response } from 'express';
import { contractVerificationService } from '../services/contractVerificationService.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const getContractVerificationStatus = asyncHandler(
  async (_req: Request, res: Response) => {
    const [stats, contracts] = await Promise.all([
      contractVerificationService.getVerificationStats(),
      contractVerificationService.getAllVerificationStatuses(),
    ]);

    res.json({ ...stats, contracts });
  },
);

/**
 * GET /admin/contract-verification
 * Returns the last WASM hash verification result for each tracked contract.
 */
export const getContractVerification = asyncHandler(
  async (_req: Request, res: Response) => {
    const results = await contractVerificationService.getWasmHashVerificationResults();
    res.json({ contracts: results, count: results.length });
  },
);
