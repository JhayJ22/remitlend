/**
 * Routes for orphaned transaction reconciliation (issue #858).
 *
 * Mounted at /api/transactions and /api/v1/transactions (see app.ts).
 * Admin endpoints live under /api/v1/admin/transactions (see adminRoutes.ts addition).
 */

import { Router } from 'express';
import { requireJwtAuth } from '../middleware/jwtAuth.js';
import { requireApiKey } from '../middleware/auth.js';
import {
  getTransactionReconciliation,
  resubmitOrphanedTransaction,
} from '../controllers/orphanedTxController.js';

const router = Router();

/**
 * GET /:txHash/reconciliation
 *
 * Returns the reconciliation record for the given transaction hash.
 * Accessible by the original submitter (JWT) or an admin:reconciliation key.
 */
router.get(
  '/:txHash/reconciliation',
  (req, res, next) => {
    // Accept either a valid JWT or an admin API key — try API key first,
    // fall through to JWT if the x-api-key header is absent.
    if (req.headers['x-api-key']) {
      return requireApiKey('admin:reconciliation')(req, res, next);
    }
    return requireJwtAuth(req, res, next);
  },
  getTransactionReconciliation,
);

/**
 * POST /:txHash/resubmit
 *
 * Approves resubmission of an orphaned transaction. Blocked in every state
 * except `orphaned` to prevent double-execution.
 */
router.post(
  '/:txHash/resubmit',
  (req, res, next) => {
    if (req.headers['x-api-key']) {
      return requireApiKey('admin:reconciliation')(req, res, next);
    }
    return requireJwtAuth(req, res, next);
  },
  resubmitOrphanedTransaction,
);

export default router;
