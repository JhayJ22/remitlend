/**
 * Routes for break-glass production access (issue #849).
 * Mounted at /api/admin and /api/v1/admin by adminRoutes.ts.
 *
 * All routes require either:
 *   - JWT authentication + admin role  (requireJwtAuth + requireRoles('admin')), or
 *   - admin:break-glass API key        (requireApiKey('admin:break-glass'))
 *
 * The dual-auth pattern (try API key first, fall through to JWT) supports
 * both human operators (JWT) and incident-automation scripts (API key).
 */

import { Router } from 'express';
import { requireJwtAuth, requireRoles } from '../middleware/jwtAuth.js';
import { requireApiKey } from '../middleware/auth.js';
import { strictRateLimiter } from '../middleware/rateLimiter.js';
import { auditLog } from '../middleware/auditLog.js';
import {
  createBreakGlassRequest,
  listBreakGlassGrants,
  getBreakGlassGrant,
  approveBreakGlassGrant,
  denyBreakGlassGrant,
  activateBreakGlassGrant,
  revokeBreakGlassGrant,
} from '../controllers/breakGlassController.js';

const router = Router();

/** Middleware that accepts either a valid JWT admin or an admin:break-glass API key. */
function requireBreakGlassAuth(req: Parameters<typeof requireJwtAuth>[0], res: Parameters<typeof requireJwtAuth>[1], next: Parameters<typeof requireJwtAuth>[2]): void {
  if (req.headers['x-api-key']) {
    return requireApiKey('admin:break-glass')(req, res, next);
  }
  void requireJwtAuth(req, res, (err?: unknown) => {
    if (err) return next(err);
    return requireRoles('admin')(req, res, next);
  });
}

// List and create
router.get('/break-glass', requireBreakGlassAuth, listBreakGlassGrants);

router.post(
  '/break-glass',
  requireBreakGlassAuth,
  strictRateLimiter,
  auditLog,
  createBreakGlassRequest,
);

// Single grant
router.get('/break-glass/:id', requireBreakGlassAuth, getBreakGlassGrant);

// Lifecycle transitions (all state-mutating, all audited + rate-limited)
router.post(
  '/break-glass/:id/approve',
  requireBreakGlassAuth,
  strictRateLimiter,
  auditLog,
  approveBreakGlassGrant,
);

router.post(
  '/break-glass/:id/deny',
  requireBreakGlassAuth,
  strictRateLimiter,
  auditLog,
  denyBreakGlassGrant,
);

router.post(
  '/break-glass/:id/activate',
  requireBreakGlassAuth,
  strictRateLimiter,
  auditLog,
  activateBreakGlassGrant,
);

router.post(
  '/break-glass/:id/revoke',
  requireBreakGlassAuth,
  strictRateLimiter,
  auditLog,
  revokeBreakGlassGrant,
);

export default router;
