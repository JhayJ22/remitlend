/**
 * Consent ledger HTTP controller (#845).
 *
 * All endpoints require JWT authentication; the authenticated wallet public
 * key is used as the user identifier — users can only read and modify their
 * own consent records.
 */

import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  grantConsent,
  revokeConsent,
  listConsentHistory,
  getEffectiveConsents,
  CONSENT_PURPOSES,
  CONSENT_DATA_CATEGORIES,
  CURRENT_POLICY_VERSION,
} from '../services/consentLedgerService.js';

/**
 * GET /user/consent
 * Returns the effective (current) consent status for every purpose.
 */
export const getEffectiveConsentsHandler = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.publicKey;
    const consents = await getEffectiveConsents(userId);
    res.json({ success: true, data: { consents } });
  },
);

/**
 * GET /user/consent/history
 * Returns the full append-only consent history (newest first).
 * Optional query params: purpose, limit, cursor (ISO timestamp for pagination).
 */
export const getConsentHistoryHandler = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.publicKey;

    const purpose =
      typeof req.query.purpose === 'string' ? req.query.purpose : undefined;
    const limit =
      typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
    const cursor =
      typeof req.query.cursor === 'string' ? req.query.cursor : undefined;

    const history = await listConsentHistory(userId, {
      purpose: purpose as Parameters<typeof listConsentHistory>[1]['purpose'],
      limit,
      cursor,
    });

    res.json({ success: true, data: { history } });
  },
);

/**
 * POST /user/consent/grant
 * Records a new consent grant for a processing purpose.
 * Body: { purpose, policy_version, data_categories }
 */
export const grantConsentHandler = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.publicKey;
    const idempotencyKey = req.header('Idempotency-Key')!;
    const ipAddress =
      (Array.isArray(req.headers['x-forwarded-for'])
        ? req.headers['x-forwarded-for'][0]
        : (req.headers['x-forwarded-for'] as string | undefined)
      )?.split(',')[0] ??
      req.ip ??
      null;
    const userAgent = typeof req.headers['user-agent'] === 'string'
      ? req.headers['user-agent']
      : null;

    const record = await grantConsent({
      userId,
      purpose: req.body.purpose,
      policyVersion: req.body.policy_version,
      dataCategories: req.body.data_categories,
      idempotencyKey,
      ipAddress,
      userAgent,
    });

    res.status(201).json({ success: true, data: record });
  },
);

/**
 * POST /user/consent/revoke
 * Records a revocation for an active consent grant.
 * Body: { purpose, revocation_reason? }
 */
export const revokeConsentHandler = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.publicKey;
    const idempotencyKey = req.header('Idempotency-Key')!;
    const ipAddress =
      (Array.isArray(req.headers['x-forwarded-for'])
        ? req.headers['x-forwarded-for'][0]
        : (req.headers['x-forwarded-for'] as string | undefined)
      )?.split(',')[0] ??
      req.ip ??
      null;
    const userAgent = typeof req.headers['user-agent'] === 'string'
      ? req.headers['user-agent']
      : null;

    const record = await revokeConsent({
      userId,
      purpose: req.body.purpose,
      revocationReason: req.body.revocation_reason ?? null,
      idempotencyKey,
      ipAddress,
      userAgent,
    });

    res.json({ success: true, data: record });
  },
);

/**
 * GET /user/consent/meta
 * Returns supported purposes, data categories, and current policy version.
 * No auth required — static metadata for onboarding / consent UI rendering.
 */
export const getConsentMetaHandler = asyncHandler(
  async (_req: Request, res: Response): Promise<void> => {
    res.json({
      success: true,
      data: {
        purposes: CONSENT_PURPOSES,
        dataCategories: CONSENT_DATA_CATEGORIES,
        currentPolicyVersion: CURRENT_POLICY_VERSION,
      },
    });
  },
);
