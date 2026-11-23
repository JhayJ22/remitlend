import type { Request, Response } from 'express';
import { AppError } from '../errors/AppError.js';
import { ErrorCode } from '../errors/errorCodes.js';
import { statementManifestService } from '../services/statementManifestService.js';
import type { StatementManifestRequest } from '../schemas/statementManifestSchemas.js';

export const signStatementManifest = async (req: Request, res: Response): Promise<void> => {
  const actor = req.user?.publicKey;
  if (!actor) {
    throw AppError.unauthorized('Authentication required', ErrorCode.UNAUTHORIZED);
  }

  const manifest = await statementManifestService.issueManifest(
    req.body as StatementManifestRequest,
    actor,
  );
  res.status(201).json({ success: true, data: manifest });
};

export const getStatementVerificationKey = async (_req: Request, res: Response): Promise<void> => {
  const verification = statementManifestService.getVerificationKey();
  res.json({ success: true, data: verification });
};
