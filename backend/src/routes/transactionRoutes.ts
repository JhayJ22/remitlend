import { Router } from 'express';
import {
  listMyTransactions,
  createDiagnosticBundle,
  getDiagnosticBundle,
  deleteDiagnosticBundle,
} from '../controllers/transactionController.js';
import { requireJwtAuth } from '../middleware/jwtAuth.js';
import { requireTransactionAccess } from '../middleware/loanAccess.js';

const router = Router();

router.get('/me', requireJwtAuth, listMyTransactions);
// Paginated list filtered by the authenticated wallet address.
router.get('/', requireJwtAuth, listMyTransactions);

router.post(
  '/:txHash/diagnostic-bundle',
  requireJwtAuth,
  requireTransactionAccess,
  createDiagnosticBundle,
);

router.get(
  '/:txHash/diagnostic-bundle/:bundleId',
  requireJwtAuth,
  requireTransactionAccess,
  getDiagnosticBundle,
);

router.delete(
  '/:txHash/diagnostic-bundle/:bundleId',
  requireJwtAuth,
  requireTransactionAccess,
  deleteDiagnosticBundle,
);

export default router;
