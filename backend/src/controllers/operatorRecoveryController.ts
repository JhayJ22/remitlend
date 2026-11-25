/**
 * Controller layer for signed operator recovery actions (#866).
 *
 * All endpoints require:
 *  - JWT authentication (requireJwtAuth)
 *  - admin role (requireRoles('admin'))
 *  - admin:recovery scoped API key (requireApiKey('admin:recovery'))
 *
 * Input validation is performed by Zod schemas before reaching these handlers.
 */

import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../errors/AppError.js';
import {
  createRecoveryAction,
  executeRecoveryAction,
  rejectRecoveryAction,
  getRecoveryAction,
  listRecoveryActions,
  OPERATOR_RECOVERY_ACTION_TYPES,
  RECOVERY_REASON_CODES,
} from '../services/operatorRecoveryService.js';

/** POST /admin/recovery-actions */
export const createRecoveryActionHandler = asyncHandler(async (req: Request, res: Response) => {
  const record = await createRecoveryAction({
    operatorId: req.user!.publicKey,
    actionType: req.body.action_type,
    reasonCode: req.body.reason_code,
    approvalReference: req.body.approval_reference,
    idempotencyKey: req.header('Idempotency-Key') ?? req.body.idempotency_key,
    operatorSignature: req.body.operator_signature,
    payload: req.body.payload,
    reasonNote: req.body.reason_note,
  });
  res.status(201).json({ success: true, data: record });
});

/** GET /admin/recovery-actions */
export const listRecoveryActionsHandler = asyncHandler(async (req: Request, res: Response) => {
  const limit = Number(req.query.limit);
  const cursor = Number(req.query.cursor);

  const records = await listRecoveryActions({
    ...(typeof req.query.operator_id === 'string' ? { operatorId: req.query.operator_id } : {}),
    ...(typeof req.query.action_type === 'string' ? { actionType: req.query.action_type } : {}),
    ...(typeof req.query.status === 'string' ? { status: req.query.status } : {}),
    ...(typeof req.query.approval_reference === 'string'
      ? { approvalReference: req.query.approval_reference }
      : {}),
    ...(Number.isInteger(limit) && limit > 0 ? { limit } : {}),
    ...(Number.isInteger(cursor) && cursor > 0 ? { cursor } : {}),
  });

  res.json({ success: true, data: { recovery_actions: records } });
});

/** GET /admin/recovery-actions/:id */
export const getRecoveryActionHandler = asyncHandler(async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  const record = await getRecoveryAction(id);
  res.json({ success: true, data: record });
});

/** POST /admin/recovery-actions/:id/execute */
export const executeRecoveryActionHandler = asyncHandler(async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  const record = await executeRecoveryAction(id, req.user!.publicKey);
  const statusCode = record.status === 'completed' ? 200 : 502;
  res.status(statusCode).json({ success: true, data: record });
});

/** POST /admin/recovery-actions/:id/reject */
export const rejectRecoveryActionHandler = asyncHandler(async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  const reason = String(req.body.reason ?? '');
  const record = await rejectRecoveryAction(id, req.user!.publicKey, reason);
  res.json({ success: true, data: record });
});

/** GET /admin/recovery-actions/meta — returns supported action types and reason codes. */
export const getRecoveryMetaHandler = asyncHandler(async (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: {
      action_types: OPERATOR_RECOVERY_ACTION_TYPES,
      reason_codes: RECOVERY_REASON_CODES,
    },
  });
});

function parseId(value: string | undefined): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw AppError.badRequest('Invalid recovery action id');
  }
  return id;
}
