import { Router } from 'express';
import { getUserProfile, updateUserProfile } from '../controllers/userController.js';
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
);

export default router;
