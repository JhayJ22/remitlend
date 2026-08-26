import express from 'express';
import { internalRequestSigningMiddleware } from '../middleware/internalRequestSigning.js';

const router = express.Router();

router.use(internalRequestSigningMiddleware);

router.post('/admin/emergency-pause', (req, res) => {
  res.json({ message: 'Contract pause initiated (internal only)' });
});

router.post('/admin/contract-state-update', (req, res) => {
  res.json({ message: 'Contract state updated (internal only)' });
});

export default router;
