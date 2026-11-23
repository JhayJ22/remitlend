import { Router } from 'express';
import {
  getStatementVerificationKey,
  signStatementManifest,
} from '../controllers/statementManifestController.js';
import { requireJwtAuth } from '../middleware/jwtAuth.js';
import { validateBody } from '../middleware/validation.js';
import { statementManifestRequestSchema } from '../schemas/statementManifestSchemas.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = Router();

router.get('/verification-key', asyncHandler(getStatementVerificationKey));
router.post(
  '/manifests',
  requireJwtAuth,
  validateBody(statementManifestRequestSchema),
  asyncHandler(signStatementManifest),
);

export default router;
