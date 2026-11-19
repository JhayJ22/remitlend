/**
 * Erasure Controller (issue #847)
 *
 * User-facing:
 *   POST /user/erasure-request  — self-service right-to-erasure request
 *
 * Admin-facing:
 *   GET  /admin/erasure                   — list all requests
 *   GET  /admin/erasure/:id               — single request
 *   POST /admin/erasure/:id/execute       — execute the erasure
 *   GET  /admin/erasure/:id/certificate   — fetch + verify the certificate
 */

import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { erasureService } from '../services/erasureService.js';
import { AppError } from '../errors/AppError.js';

// ── Schemas ───────────────────────────────────────────────────────────────────

const ERASURE_REASONS = [
  'right_to_erasure',
  'account_closure',
  'gdpr_article_17',
  'ccpa_deletion',
  'other',
] as const;

export const initiateErasureSchema = z.object({
  reason: z.enum(ERASURE_REASONS),
  consent_ref: z.string().max(255).nullable().optional(),
});

export const adminInitiateErasureSchema = z.object({
  user_public_key: z.string().min(1).max(255),
  reason: z.enum(ERASURE_REASONS),
  consent_ref: z.string().max(255).nullable().optional(),
});

// ── Handlers ──────────────────────────────────────────────────────────────────

/**
 * POST /user/erasure-request
 * Self-service: authenticated user requests erasure of their own data.
 */
export async function requestSelfErasure(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const userPublicKey = req.user?.publicKey;
    if (!userPublicKey) throw AppError.unauthorized('Authentication required');

    const parsed = initiateErasureSchema.safeParse(req.body);
    if (!parsed.success) {
      throw AppError.badRequest(parsed.error.issues.map((i) => i.message).join('; '));
    }

    const request = await erasureService.initiateErasure({
      userPublicKey,
      requestedBy: userPublicKey,
      reason: parsed.data.reason,
      consentRef: parsed.data.consent_ref ?? null,
    });

    res.status(202).json({ success: true, data: request });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /admin/erasure
 * Admin initiates an erasure on behalf of a user.
 */
export async function adminInitiateErasure(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const actor = req.user?.publicKey ?? 'system:api';
    const parsed = adminInitiateErasureSchema.safeParse(req.body);
    if (!parsed.success) {
      throw AppError.badRequest(parsed.error.issues.map((i) => i.message).join('; '));
    }

    const request = await erasureService.initiateErasure({
      userPublicKey: parsed.data.user_public_key,
      requestedBy: actor,
      reason: parsed.data.reason,
      consentRef: parsed.data.consent_ref ?? null,
    });

    res.status(202).json({ success: true, data: request });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /admin/erasure
 * List erasure requests with optional status filter + cursor pagination.
 */
export async function listErasureRequests(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { status, limit, cursor } = req.query as Record<string, string | undefined>;

    const VALID_STATUSES = ['pending', 'in_progress', 'completed', 'failed', 'rejected'];
    if (status && !VALID_STATUSES.includes(status)) {
      throw AppError.badRequest(`status must be one of: ${VALID_STATUSES.join(', ')}`);
    }

    const parsedLimit = limit ? Math.min(Number(limit), 200) : 50;
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
      throw AppError.badRequest('limit must be a positive integer');
    }

    const result = await erasureService.listRequests({
      status: status as Parameters<typeof erasureService.listRequests>[0]['status'],
      limit: parsedLimit,
      cursor,
    });

    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /admin/erasure/:id
 * Single erasure request.
 */
export async function getErasureRequest(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { id } = req.params as { id: string };
    if (!id) throw AppError.badRequest('id is required');
    const request = await erasureService.getRequest(id);
    res.json({ success: true, data: request });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /admin/erasure/:id/execute
 * Execute a pending erasure request and issue the verifiable certificate.
 * Authorization: admin:all — requires a JWT-authenticated admin principal.
 */
export async function executeErasure(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { id } = req.params as { id: string };
    if (!id) throw AppError.badRequest('id is required');
    const actor = req.user?.publicKey ?? 'system:api';

    const certificate = await erasureService.executeErasure({
      requestId: id,
      executedBy: actor,
    });

    res.status(201).json({ success: true, data: certificate });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /admin/erasure/:id/certificate
 * Fetch the verifiable deletion certificate and re-verify its hash.
 */
export async function getErasureCertificate(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { id } = req.params as { id: string };
    if (!id) throw AppError.badRequest('id is required');

    // Load parent request to get user_public_key for hash verification.
    const request = await erasureService.getRequest(id);
    const cert = await erasureService.getCertificate(id);

    // Re-verify the hash on every fetch — proves the stored report is intact.
    const hashValid = erasureService.verifyCertificateHash(cert, request.user_public_key);

    res.json({
      success: true,
      data: {
        ...cert,
        hash_verified: hashValid,
      },
    });
  } catch (err) {
    next(err);
  }
}
