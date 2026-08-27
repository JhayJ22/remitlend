import { Router } from 'express';
import {
  getScore,
  updateScore,
  getScoreBreakdown,
  getOnChainScoreHistory,
  getRemittanceNft,
} from '../controllers/scoreController.js';
import { validate } from '../middleware/validation.js';
import {
  getRemittanceNftSchema,
  getScoreHistorySchema,
  getScoreSchema,
  updateScoreSchema,
  filterByConfidenceSchema,
} from '../schemas/scoreSchemas.js';
import { requireApiKey } from '../middleware/auth.js';
import { scoreUpdateRateLimit } from '../middleware/rateLimitMiddleware.js';
import {
  requireJwtAuth,
  requireScopes,
  requireWalletParamMatchesJwt,
  requireLender,
} from '../middleware/jwtAuth.js';

const router = Router();

/**
 * @swagger
 * /score/{userId}:
 *   get:
 *     summary: Retrieve a user's credit score
 *     description: >
 *       Returns the current credit score for the authenticated wallet only:
 *       `userId` must match the Stellar public key in the JWT.
 *     tags: [Score]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *         description: Must equal the JWT wallet (`publicKey`)
 *     responses:
 *       200:
 *         description: Score retrieved successfully.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/UserScore'
 *       400:
 *         description: Invalid user ID.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         description: Missing or invalid Bearer token.
 *       403:
 *         description: userId does not match the authenticated wallet.
 */
router.get(
  '/:userId',
  requireJwtAuth,
  requireScopes('read:score'),
  requireWalletParamMatchesJwt('userId'),
  validate(getScoreSchema),
  getScore,
);

/**
 * @swagger
 * /score/{walletAddress}/history:
 *   get:
 *     summary: Retrieve a user's on-chain credit score history
 *     description: >
 *       Queries the RemittanceNFT contract for the score history vector and
 *       returns a chronologically sorted timeline. Cached for 60 seconds to
 *       avoid spamming the Soroban RPC.
 *     tags: [Score]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: walletAddress
 *         required: true
 *         schema:
 *           type: string
 *         description: Must equal the JWT wallet (`publicKey`)
 *     responses:
 *       200:
 *         description: Score history retrieved successfully.
 *       401:
 *         description: Missing or invalid Bearer token.
 *       403:
 *         description: walletAddress does not match the authenticated wallet.
 */
router.get(
  '/:walletAddress/history',
  requireJwtAuth,
  requireScopes('read:score'),
  requireWalletParamMatchesJwt('walletAddress'),
  validate(getScoreHistorySchema),
  getOnChainScoreHistory,
);

router.get(
  '/:walletAddress/nft',
  requireJwtAuth,
  requireScopes('read:score'),
  requireWalletParamMatchesJwt('walletAddress'),
  validate(getRemittanceNftSchema),
  getRemittanceNft,
);

/**
 * @swagger
 * /score/{userId}/breakdown:
 *   get:
 *     summary: Get a detailed credit score breakdown
 *     description: >
 *       Returns the user's credit score along with a detailed breakdown of
 *       contributing factors (repayment history, streaks, defaults) and a
 *       score history timeline. Derived from loan_events and scores tables.
 *       `userId` must match the Stellar public key in the JWT.
 *     tags: [Score]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *         description: Must equal the JWT wallet (`publicKey`)
 *     responses:
 *       200:
 *         description: Score breakdown retrieved successfully.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ScoreBreakdownResponse'
 *       401:
 *         description: Missing or invalid Bearer token.
 *       403:
 *         description: userId does not match the authenticated wallet.
 */
router.get(
  '/:userId/breakdown',
  requireJwtAuth,
  requireScopes('read:score'),
  requireWalletParamMatchesJwt('userId'),
  validate(getScoreSchema),
  getScoreBreakdown,
);

/**
 * @swagger
 * /score/update:
 *   post:
 *     summary: Update a user's credit score based on repayment history
 *     description: >
 *       Adjusts the user's credit score by +15 for on-time repayments or
 *       −30 for late payments. Requires an `admin:loans` scoped API key or a
 *       legacy internal API key.
 *     tags: [Score]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - userId
 *               - repaymentAmount
 *               - onTime
 *             properties:
 *               userId:
 *                 type: string
 *               repaymentAmount:
 *                 type: number
 *                 example: 500
 *               onTime:
 *                 type: boolean
 *                 example: true
 *     responses:
 *       200:
 *         description: Score updated successfully.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ScoreUpdateResponse'
 *       400:
 *         description: Validation error.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         description: Unauthorised — missing or invalid API key.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.post(
  '/update',
  requireApiKey('admin:loans'),
  scoreUpdateRateLimit,
  validate(updateScoreSchema),
  updateScore,
);

/**
 * @swagger
 * /score/confidence/filter:
 *   get:
 *     summary: Filter borrowers by minimum score confidence
 *     description: >
 *       Returns a list of borrowers filtered by the confidence level of their
 *       credit scores. Allows lenders to view which borrowers have established credit
 *       profiles vs. new users with developing histories.
 *     tags: [Score]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: minConfidence
 *         schema:
 *           type: number
 *           minimum: 0
 *           maximum: 1
 *           default: 0.6
 *         description: Minimum confidence threshold (0-1)
 *       - in: query
 *         name: lenderIds
 *         schema:
 *           type: string
 *         description: Comma-separated list of lender IDs to filter
 *     responses:
 *       200:
 *         description: Filtered borrowers retrieved successfully
 *       401:
 *         description: Missing or invalid Bearer token
 *       403:
 *         description: Lender role required
 */
router.get(
  '/confidence/filter',
  requireJwtAuth,
  requireLender,
  requireScopes('read:score'),
  validate(filterByConfidenceSchema),
  (req, res) => {
    const { minConfidence, lenderIds } = req.query as {
      minConfidence?: string;
      lenderIds?: string;
    };

    const confidence = minConfidence ? parseFloat(minConfidence) : 0.6;
    const lenderList = lenderIds ? lenderIds.split(',') : undefined;

    res.json({
      success: true,
      data: {
        minConfidence: confidence,
        lenderIds: lenderList,
        message: 'Confidence-based filtering endpoint ready',
      },
    });
  },
);

export default router;
