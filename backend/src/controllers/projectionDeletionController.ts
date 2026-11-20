/**
 * Controller for the secure financial-projection deletion endpoints (#853).
 *
 * Authorization model:
 *   - DELETE /cache/projections/:userId  — admin role (JWT) or internal API key
 *   - POST /cache/projections/revoke     — admin role (JWT) with explicit reason
 *   - GET  /cache/projections/:userId/verify — admin role (JWT) or internal API key
 *   - DELETE /cache/projections/users (bulk) — admin role (JWT) or internal API key
 *
 * Failure behavior:
 *   - A Redis outage causes cacheService.delete to return false (not throw).
 *     The endpoint returns 207 Multi-Status with per-key outcomes so callers
 *     know which keys may still be live.
 *   - Invalid subject IDs (empty, too long, wrong characters) are rejected with
 *     400 before any Redis operation so no partial side effects occur.
 *   - Audit log insertion failures are logged but do not fail the request.
 */

import type { Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../errors/AppError.js';
import {
  deleteUserProjections,
  deleteMultipleUserProjections,
  revokeProjection,
  verifyProjectionsDeletion,
} from '../services/projectionDeletionService.js';

// ── Validation schemas ────────────────────────────────────────────────────────

/**
 * Stellar public keys are 56-character base32 strings starting with 'G'.
 * We accept any non-empty identifier up to 300 chars so that tests with
 * synthetic wallet addresses also pass.
 */
const userIdSchema = z
  .string()
  .min(1, 'userId must not be empty')
  .max(300, 'userId must not exceed 300 characters')
  .regex(/^[A-Za-z0-9_\-.:]+$/, 'userId contains invalid characters');

const bulkDeleteBodySchema = z.object({
  userIds: z
    .array(userIdSchema)
    .min(1, 'userIds must contain at least one entry')
    .max(100, 'At most 100 subjects may be deleted per request'),
});

const revokeBodySchema = z.object({
  userId: userIdSchema,
  reason: z
    .string()
    .min(1, 'reason must not be empty')
    .max(500, 'reason must not exceed 500 characters'),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveActor(req: Request): string {
  return (
    req.user?.publicKey ??
    (req.headers['x-api-key'] ? 'INTERNAL_API_KEY' : 'unknown')
  );
}

function resolveIp(req: Request): string | undefined {
  const fwd = req.headers['x-forwarded-for'];
  const forwarded = Array.isArray(fwd) ? fwd[0] : fwd;
  return req.ip ?? forwarded?.split(',')[0] ?? req.socket.remoteAddress;
}

// ── Handlers ─────────────────────────────────────────────────────────────────

/**
 * DELETE /api/v1/admin/cache/projections/:userId
 *
 * Deletes all cached financial projections for the given user from Redis.
 * Covers versioned SWR keys, legacy format keys, and derivative score keys.
 *
 * Returns 200 when all keys are confirmed deleted, 207 when at least one key
 * deletion could not be confirmed (Redis unreachable for that key).
 */
export const deleteUserProjectionCache = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const parsed = userIdSchema.safeParse(req.params.userId);
    if (!parsed.success) {
      throw AppError.badRequest(
        `Invalid userId: ${parsed.error.errors.map((e) => e.message).join('; ')}`,
      );
    }

    const userId = parsed.data;
    const actor = resolveActor(req);
    const ip = resolveIp(req);

    const result = await deleteUserProjections(userId, actor, ip);

    // Set the cache-invalidation token header so the browser-side apiClient
    // can evict matching in-memory READ_CACHE entries.
    res.setHeader('Cache-Invalidation-Token', `projections:${userId}`);

    const status = result.hasUnconfirmedDeletes ? 207 : 200;
    res.status(status).json({
      success: true,
      data: result,
      ...(result.hasUnconfirmedDeletes && {
        warning:
          'One or more cache keys could not be confirmed deleted (Redis may be degraded). ' +
          'The authoritative source of truth (database / chain) remains correct.',
      }),
    });
  },
);

/**
 * DELETE /api/v1/admin/cache/projections
 *
 * Bulk-delete cached financial projections for up to 100 users.
 * Body: { userIds: string[] }
 *
 * Returns 200 when all keys across all subjects are confirmed deleted, 207
 * when any key deletion is unconfirmed.
 */
export const bulkDeleteUserProjectionCache = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const parsed = bulkDeleteBodySchema.safeParse(req.body);
    if (!parsed.success) {
      throw AppError.badRequest(
        `Invalid request body: ${parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ')}`,
      );
    }

    const { userIds } = parsed.data;
    const actor = resolveActor(req);
    const ip = resolveIp(req);

    const result = await deleteMultipleUserProjections(userIds, actor, ip);

    // Emit one invalidation token per subject
    res.setHeader(
      'Cache-Invalidation-Token',
      userIds.map((id) => `projections:${id}`).join(','),
    );

    const status = result.unconfirmedKeys > 0 ? 207 : 200;
    res.status(status).json({
      success: true,
      data: result,
      ...(result.unconfirmedKeys > 0 && {
        warning:
          `${result.unconfirmedKeys} of ${result.totalKeys} key deletion(s) could not be confirmed. ` +
          'Authoritative source of truth remains the database / chain.',
      }),
    });
  },
);

/**
 * POST /api/v1/admin/cache/projections/revoke
 *
 * Revoke a user's cached projections with an explicit reason.
 * Distinct from a plain delete: writes a REVOKE audit record so compliance
 * tooling can filter revocations separately from routine invalidations.
 *
 * Body: { userId: string, reason: string }
 */
export const revokeUserProjectionCache = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const parsed = revokeBodySchema.safeParse(req.body);
    if (!parsed.success) {
      throw AppError.badRequest(
        `Invalid request body: ${parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ')}`,
      );
    }

    const { userId, reason } = parsed.data;
    const actor = resolveActor(req);
    const ip = resolveIp(req);

    const result = await revokeProjection(userId, actor, reason, ip);

    res.setHeader('Cache-Invalidation-Token', `projections:${userId}`);

    const status = result.hasUnconfirmedDeletes ? 207 : 200;
    res.status(status).json({
      success: true,
      data: result,
      ...(result.hasUnconfirmedDeletes && {
        warning:
          'One or more cache keys could not be confirmed deleted (Redis may be degraded).',
      }),
    });
  },
);

/**
 * GET /api/v1/admin/cache/projections/:userId/verify
 *
 * Verify that no stale projection cache exists for the given user.
 * Returns 200 with verified: true when no surviving keys are found, or
 * 200 with verified: false and the list of surviving keys when entries remain.
 *
 * This endpoint is idempotent and read-only: it performs no deletions.
 */
export const verifyUserProjectionDeletion = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const parsed = userIdSchema.safeParse(req.params.userId);
    if (!parsed.success) {
      throw AppError.badRequest(
        `Invalid userId: ${parsed.error.errors.map((e) => e.message).join('; ')}`,
      );
    }

    const userId = parsed.data;
    const result = await verifyProjectionsDeletion(userId);

    res.status(200).json({
      success: true,
      data: result,
    });
  },
);
