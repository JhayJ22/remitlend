import { Router } from 'express';
import {
  getUserProfile,
  updateUserProfile,
  getTransferHistory,
  listRecipients,
  addRecipient,
  deleteRecipient,
} from '../controllers/userController.js';
import { requireJwtAuth } from '../middleware/jwtAuth.js';
import { validateBody } from '../middleware/validation.js';
import { updateUserProfileSchema } from '../schemas/userSchemas.js';
import { strictRateLimiter } from '../middleware/rateLimiter.js';
import {
  getEffectiveConsentsHandler,
  getConsentHistoryHandler,
  grantConsentHandler,
  revokeConsentHandler,
  getConsentMetaHandler,
} from '../controllers/consentController.js';
import { grantConsentSchema, revokeConsentSchema } from '../schemas/consentSchemas.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { requestSelfErasure } from '../controllers/erasureController.js';

const router = Router();

/**
 * @swagger
 * /user/profile:
 *   get:
 *     summary: Get the authenticated user's profile
 *     tags: [User]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: User profile returned, creating an empty profile on first access.
 *       401:
 *         description: Missing or invalid JWT
 */
router.get('/profile', requireJwtAuth, getUserProfile);

/**
 * @swagger
 * /user/profile:
 *   patch:
 *     summary: Update the authenticated user's profile
 *     tags: [User]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: false
 *             properties:
 *               displayName:
 *                 type: string
 *                 nullable: true
 *               email:
 *                 type: string
 *                 format: email
 *                 nullable: true
 *               phone:
 *                 type: string
 *                 nullable: true
 *               locale:
 *                 type: string
 *                 nullable: true
 *                 example: en-US
 *               avatarUrl:
 *                 type: string
 *                 format: uri
 *                 nullable: true
 *     responses:
 *       200:
 *         description: Updated user profile
 *       400:
 *         description: Validation error
 *       401:
 *         description: Missing or invalid JWT
 */
router.patch('/profile', requireJwtAuth, validateBody(updateUserProfileSchema), updateUserProfile);

router.get('/recipients', requireJwtAuth, listRecipients);
router.post('/recipients', requireJwtAuth, addRecipient);
router.delete('/recipients/:id', requireJwtAuth, deleteRecipient);

/**
 * @swagger
 * /users/{id}/transfer-history:
 *   get:
 *     summary: Paginated NFT transfer history with corridor, amount and timestamp
 *     tags: [User]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Transfer history page
 */
router.get('/:id/transfer-history', requireJwtAuth, getTransferHistory);
// ─── Consent ledger endpoints (#845) ─────────────────────────────────────────

/**
 * @swagger
 * /user/consent/meta:
 *   get:
 *     summary: Supported purposes, data categories, and current policy version
 *     tags: [Consent]
 *     responses:
 *       200:
 *         description: Consent metadata
 */
router.get('/consent/meta', getConsentMetaHandler);

/**
 * @swagger
 * /user/consent:
 *   get:
 *     summary: Effective (current) consent status for every purpose
 *     tags: [Consent]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Array of effective consent records
 *       401:
 *         description: Missing or invalid JWT
 */
router.get('/consent', requireJwtAuth, getEffectiveConsentsHandler);

/**
 * @swagger
 * /user/consent/history:
 *   get:
 *     summary: Full append-only consent history for the authenticated user
 *     tags: [Consent]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: purpose
 *         schema:
 *           type: string
 *         description: Filter by purpose
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *       - in: query
 *         name: cursor
 *         schema:
 *           type: string
 *         description: ISO timestamp for keyset pagination (returns rows older than this)
 *     responses:
 *       200:
 *         description: Paginated consent history
 *       401:
 *         description: Missing or invalid JWT
 */
router.get('/consent/history', requireJwtAuth, getConsentHistoryHandler);

/**
 * @swagger
 * /user/consent/grant:
 *   post:
 *     summary: Grant consent for a data processing purpose
 *     tags: [Consent]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [purpose, policy_version, data_categories]
 *             properties:
 *               purpose:
 *                 type: string
 *                 enum: [credit_score_processing, remittance_analytics, marketing_communications, third_party_sharing]
 *               policy_version:
 *                 type: string
 *                 example: "1.0"
 *               data_categories:
 *                 type: array
 *                 items:
 *                   type: string
 *                   enum: [wallet_address, credit_score, remittance_history, loan_history, contact_info]
 *     responses:
 *       201:
 *         description: Consent granted
 *       400:
 *         description: Validation error
 *       401:
 *         description: Missing or invalid JWT
 *       409:
 *         description: Duplicate idempotency key
 */
router.post(
  '/consent/grant',
  requireJwtAuth,
  strictRateLimiter,
  validateBody(grantConsentSchema),
  grantConsentHandler,
);

/**
 * @swagger
 * /user/consent/revoke:
 *   post:
 *     summary: Revoke consent for a data processing purpose
 *     tags: [Consent]
/**
 * @swagger
 * /user/erasure-request:
 *   post:
 *     summary: Request erasure of your own personal data (right to erasure)
 *     description: >
 *       Submits a right-to-erasure request for the authenticated user's PII.
 *       The request is queued as 'pending' and must be executed by an admin.
 *       Rejected if the user has an active financial obligation (outstanding loan).
 *       Idempotent: a second request is rejected while one is already pending or in-progress.
 *     tags: [User]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [purpose]
 *             properties:
 *               purpose:
 *                 type: string
 *                 enum: [credit_score_processing, remittance_analytics, marketing_communications, third_party_sharing]
 *               revocation_reason:
 *                 type: string
 *                 maxLength: 500
 *     responses:
 *       200:
 *         description: Consent revoked
 *       400:
 *         description: Validation error
 *       401:
 *         description: Missing or invalid JWT
 *       404:
 *         description: No active consent found for this purpose
 *       409:
 *         description: Consent already revoked, or duplicate idempotency key
 */
router.post(
  '/consent/revoke',
  requireJwtAuth,
  strictRateLimiter,
  validateBody(revokeConsentSchema),
  revokeConsentHandler,
 *             required: [reason]
 *             properties:
 *               reason:
 *                 type: string
 *                 enum: [right_to_erasure, account_closure, gdpr_article_17, ccpa_deletion, other]
 *               consent_ref:
 *                 type: string
 *                 nullable: true
 *     responses:
 *       202:
 *         description: Erasure request queued
 *       400:
 *         description: Validation error
 *       409:
 *         description: Duplicate request or active financial obligation
 */
router.post(
  '/erasure-request',
  requireJwtAuth,
  strictRateLimiter,
  asyncHandler(requestSelfErasure),
);

export default router;
