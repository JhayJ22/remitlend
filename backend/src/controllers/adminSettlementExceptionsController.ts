import type { Request, Response } from 'express';
import { getSettlementExceptions } from '../services/settlementExceptionsService.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const getAdminSettlementExceptions = asyncHandler(
  async (_req: Request, res: Response) => {
    res.json(await getSettlementExceptions());
  },
);
