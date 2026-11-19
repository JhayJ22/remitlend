import { Router } from 'express';
import { getUserProfile, updateUserProfile } from '../controllers/userController.js';
import { requireJwtAuth } from '../middleware/jwtAuth.js';
import { validateBody } from '../middleware/validation.js';
import { updateUserProfileSchema } from '../schemas/userSchemas.js';
import { strictRateLimiter } from '../middleware/rateLimiter.js';
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
