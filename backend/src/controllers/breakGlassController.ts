/**
 * Controller for break-glass production access endpoints (issue #849).
 *
 * All endpoints require the caller to be a JWT-authenticated admin-role wallet
 * or present an admin:break-glass API key. The x-api-key path is for
 * automated tooling (runbooks, incident-management scripts).
 *
 * Endpoints:
 *   POST   /api/v1/admin/break-glass
 *       Request a new break-glass grant. The requesting admin must supply a
 *       ticket reference, reason, desired scopes, and duration.
 *
 *   GET    /api/v1/admin/break-glass
 *       List all grants (filterable by state/requester, cursor-paginated).
 *       Admin only — full visibility including pending and historical records.
 *
 *   GET    /api/v1/admin/break-glass/:id
 *       Fetch a single grant by ID.
 *
 *   POST   /api/v1/admin/break-glass/:id/approve
 *       Approve a pending grant. The approver must differ from the requester.
 *       The approver specifies the granted scopes (may be a strict subset).
 *
 *   POST   /api/v1/admin/break-glass/:id/deny
 *       Deny a pending grant with a mandatory reason.
 *
 *   POST   /api/v1/admin/break-glass/:id/activate
 *       Activate an approved grant. Only the requester may call this.
 *       The expiry clock starts at activation time.
 *
 *   POST   /api/v1/admin/break-glass/:id/revoke
 *       Revoke a grant from any non-terminal state. Any admin may revoke.
 *       Requires a mandatory revocation reason.
 */

import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../errors/AppError.js';
import {
  requestBreakGlass,
  approveBreakGlass,
  denyBreakGlass,
  activateBreakGlass,
  revokeBreakGlass,
  getGrantById,
  listGrants,
  BREAK_GLASS_ALLOWED_SCOPES,
  type BreakGlassState,
} from '../services/breakGlassService.js';

// ── Helpers ───────────────────────────────────────────────────────────────

function parseId(raw: unknown): number {
  const n = Number.parseInt(typeof raw === 'string' ? raw : '', 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw AppError.badRequest('id must be a positive integer');
  }
  return n;
}

function callerPublicKey(req: Request): string {
  // JWT path: req.user.publicKey is set by requireJwtAuth
  if (req.user?.publicKey) return req.user.publicKey;
  // API-key path: use the x-api-key header value as the actor identifier
  const key = req.headers['x-api-key'];
  if (key) return `api_key:${Array.isArray(key) ? key[0] : key}`;
  throw AppError.unauthorized('Authentication required');
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string') as string[];
  if (typeof value === 'string') return value.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

// ── Controllers ───────────────────────────────────────────────────────────

/**
 * POST /api/v1/admin/break-glass
 *
 * @openapi
 * /api/v1/admin/break-glass:
 *   post:
 *     summary: Request emergency break-glass access
 *     tags: [Admin, BreakGlass]
 *     security:
 *       - bearerAuth: []
 *       - apiKey: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [ticketRef, reason, requestedScopes]
 *             properties:
 *               ticketRef:
 *                 type: string
 *                 description: "Incident or change-ticket ID (e.g. INC-1234)"
 *               reason:
 *                 type: string
 *                 minLength: 20
 *               requestedScopes:
 *                 type: array
 *                 items: { type: string }
 *               durationSeconds:
 *                 type: integer
 *                 description: "Desired grant duration (default 1h, max configurable)"
 *     responses:
 *       201:
 *         description: Grant request created; pending independent approval
 *       400:
 *         description: Validation error (missing ticket, short reason, invalid scopes)
 */
export const createBreakGlassRequest = asyncHandler(async (req: Request, res: Response) => {
  const body = req.body as {
    ticketRef?: unknown;
    reason?: unknown;
    requestedScopes?: unknown;
    durationSeconds?: unknown;
  };

  const ticketRef = typeof body.ticketRef === 'string' ? body.ticketRef.trim() : '';
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  const requestedScopes = parseStringArray(body.requestedScopes);
  const durationSeconds =
    typeof body.durationSeconds === 'number' ? body.durationSeconds : undefined;

  const grant = await requestBreakGlass({
    ticketRef,
    reason,
    requester: callerPublicKey(req),
    requestedScopes,
    durationSeconds,
  });

  res.status(201).json({ success: true, data: grant });
});

/**
 * GET /api/v1/admin/break-glass
 */
export const listBreakGlassGrants = asyncHandler(async (req: Request, res: Response) => {
  const validStates: BreakGlassState[] = [
    'pending', 'approved', 'active', 'denied', 'expired', 'revoked',
  ];

  const rawState = req.query.state;
  const state =
    typeof rawState === 'string' && validStates.includes(rawState as BreakGlassState)
      ? (rawState as BreakGlassState)
      : undefined;

  const rawRequester = req.query.requester;
  const requester = typeof rawRequester === 'string' ? rawRequester : undefined;

  const limit = Math.min(
    Number.parseInt(typeof req.query.limit === 'string' ? req.query.limit : '50', 10) || 50,
    200,
  );
  const rawCursor = req.query.cursor;
  const cursor =
    typeof rawCursor === 'string' ? Number.parseInt(rawCursor, 10) || undefined : undefined;

  const grants = await listGrants({ state, requester, limit, cursor });
  const hasNext = grants.length === limit;

  res.json({
    success: true,
    data: grants,
    page_info: {
      limit,
      count: grants.length,
      next_cursor: hasNext ? String(grants[grants.length - 1]?.id) : null,
      has_next: hasNext,
    },
    meta: {
      allowedScopes: BREAK_GLASS_ALLOWED_SCOPES,
    },
  });
});

/**
 * GET /api/v1/admin/break-glass/:id
 */
export const getBreakGlassGrant = asyncHandler(async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  const grant = await getGrantById(id);
  res.json({ success: true, data: grant });
});

/**
 * POST /api/v1/admin/break-glass/:id/approve
 *
 * @openapi
 * /api/v1/admin/break-glass/{id}/approve:
 *   post:
 *     summary: Approve a pending break-glass grant
 *     description: >
 *       The approver must be a different admin than the requester.
 *       Granted scopes may be a strict subset of the requested scopes.
 *     tags: [Admin, BreakGlass]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [grantedScopes]
 *             properties:
 *               grantedScopes:
 *                 type: array
 *                 items: { type: string }
 *     responses:
 *       200:
 *         description: Grant approved
 *       403:
 *         description: Self-approval attempted
 *       409:
 *         description: Grant not in pending state
 */
export const approveBreakGlassGrant = asyncHandler(async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  const body = req.body as { grantedScopes?: unknown };
  const grantedScopes = parseStringArray(body.grantedScopes);

  const grant = await approveBreakGlass({
    id,
    approver: callerPublicKey(req),
    grantedScopes,
  });

  res.json({ success: true, data: grant });
});

/**
 * POST /api/v1/admin/break-glass/:id/deny
 */
export const denyBreakGlassGrant = asyncHandler(async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  const body = req.body as { denialReason?: unknown };
  const denialReason =
    typeof body.denialReason === 'string' ? body.denialReason.trim() : '';

  const grant = await denyBreakGlass({
    id,
    approver: callerPublicKey(req),
    denialReason,
  });

  res.json({ success: true, data: grant });
});

/**
 * POST /api/v1/admin/break-glass/:id/activate
 *
 * @openapi
 * /api/v1/admin/break-glass/{id}/activate:
 *   post:
 *     summary: Activate an approved break-glass grant
 *     description: >
 *       Only the requester may activate. The expiry clock starts at
 *       activation time, not at approval time.
 *     responses:
 *       200:
 *         description: Grant is now active; expiresAt is set
 *       403:
 *         description: Caller is not the requester
 *       409:
 *         description: Grant not in approved state
 */
export const activateBreakGlassGrant = asyncHandler(async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  const grant = await activateBreakGlass(id, callerPublicKey(req));
  res.json({ success: true, data: grant });
});

/**
 * POST /api/v1/admin/break-glass/:id/revoke
 *
 * @openapi
 * /api/v1/admin/break-glass/{id}/revoke:
 *   post:
 *     summary: Revoke a break-glass grant
 *     description: >
 *       Any admin may revoke from any non-terminal state.
 *       Revocation is immediate and fires an alert.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [revocationReason]
 *             properties:
 *               revocationReason:
 *                 type: string
 *                 minLength: 10
 *     responses:
 *       200:
 *         description: Grant revoked
 *       400:
 *         description: Revocation reason too short
 *       409:
 *         description: Grant already in terminal state
 */
export const revokeBreakGlassGrant = asyncHandler(async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  const body = req.body as { revocationReason?: unknown };
  const revocationReason =
    typeof body.revocationReason === 'string' ? body.revocationReason.trim() : '';

  const grant = await revokeBreakGlass({
    id,
    revokedBy: callerPublicKey(req),
    revocationReason,
  });

  res.json({ success: true, data: grant });
});
