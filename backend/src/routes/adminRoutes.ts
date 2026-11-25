import { Router, type Response } from 'express';
import type { Pool } from 'pg';
import {
  DiagnosticBundleError,
  DiagnosticBundleService,
} from '../services/diagnosticBundleService.js';
import { z } from 'zod';
import { requireApiKey } from '../middleware/auth.js';
import { requireJwtAuth, requireRoles, requireScopes } from '../middleware/jwtAuth.js';
import { strictRateLimiter } from '../middleware/rateLimiter.js';
import { validateBody } from '../middleware/validation.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { auditLog } from '../middleware/auditLog.js';
import { defaultChecker } from '../services/defaultChecker.js';
import {
  createWebhookSubscription,
  deleteWebhookSubscription,
  getWebhookDeliveries,
  getWebhookSubscriptionAudit,
  listWebhookDeadLetters,
  redriveWebhookDelivery,
  listQuarantinedEvents,
  listWebhookSubscriptions,
  reprocessQuarantinedEvents,
  reindexLedgerRange,
  updateWebhookSubscription,
} from '../controllers/indexerController.js';
import {
  listLoanDisputes,
  resolveLoanDispute,
  getLoanDispute,
  rejectLoanDispute,
  reviewLoanDispute,
} from '../controllers/adminDisputeController.js';
import { getPendingGovernance } from '../controllers/adminGovernanceController.js';
import {
  getContractVerification,
  getContractVerificationStatus,
} from '../controllers/adminContractVerificationController.js';
import { query } from '../db/connection.js';
import { getReconciliationStatus } from '../services/crossContractReconciler.js';
import { createSupportedAsset } from '../services/assetAllowlistService.js';

import { buildRejectLoanTx } from '../controllers/loanController.js';
import { listAuditLogs } from '../controllers/authController.js';
import { exportAuditLogs, verifyAuditLogs } from '../controllers/auditLogExportController.js';
import {
  deleteUserProjectionCache,
  bulkDeleteUserProjectionCache,
  revokeUserProjectionCache,
  verifyUserProjectionDeletion,
} from '../controllers/projectionDeletionController.js';
import {
  listLoanStateEventsEndpoint,
  replayLoanStateEndpoint,
} from '../controllers/loanStateEventController.js';
import {
  getNetworkTelemetry,
  getNetworkFailoverEvents,
  listDeadLetterWrites,
  redriveDeadLetterWrite,
} from '../controllers/networkTelemetryController.js';

import { listDiscrepancies, acknowledgeDiscrepancy, exportDiscrepanciesCSV } from '../services/discrepancyLedgerService.js';
import { listDiscrepancies } from '../services/discrepancyLedgerService.js';
import breakGlassRoutes from './breakGlassRoutes.js';
import {
  listTransactionReconciliations,
  resolveOrphanedTransaction,
} from '../controllers/orphanedTxController.js';
import {
  getAlertOwnership,
  updateAlertOwnership,
  startAlertDrill,
  createIncidentEvidenceBundle,
  getIncidentEvidenceBundle,
  getClockSkewReport,
} from '../controllers/operationsController.js';
import {
  alertOwnershipUpdateSchema,
  alertDrillSchema,
  incidentBundleCreateSchema,
} from '../schemas/operationsSchemas.js';
import { idempotency } from '../middleware/idempotency.js';
import {
  createRequest as createPrivilegedRequest,
  approveRequest as approvePrivilegedRequest,
  revokeRequest as revokePrivilegedRequest,
  executeRequest as executePrivilegedRequest,
  getRequest as getPrivilegedRequest,
} from '../services/privilegedActionService.js';
import {
  listEvidenceHandler,
  getEvidenceHandler,
  verifyEvidenceHandler,
  getEvidenceMetaHandler,
} from '../controllers/evidenceProvenanceController.js';
  createRecoveryActionHandler,
  listRecoveryActionsHandler,
  getRecoveryActionHandler,
  executeRecoveryActionHandler,
  rejectRecoveryActionHandler,
  getRecoveryMetaHandler,
} from '../controllers/operatorRecoveryController.js';
import { AppError } from '../errors/AppError.js';
import { getAbuseTelemetryReport } from '../controllers/abuseTelemetryController.js';
import {
  recordChange,
  listChanges,
  getChange,
  recoverChange,
  createSnapshot,
  reviewSnapshot,
  listSnapshots,
} from '../controllers/configIntegrityController.js';
  adminInitiateErasure,
  listErasureRequests,
  getErasureRequest,
  executeErasure,
  getErasureCertificate,
} from '../controllers/erasureController.js';
  initiateReview,
  approveReview,
  listReviews,
  getReview,
  getCurrentReviews,
  recordChange,
  listChanges,
  runGateCheck,
} from '../controllers/threatModelController.js';

const router = Router();

const diagnostics = () => new DiagnosticBundleService({ query } as unknown as Pool);
const handleDiagnosticError = (err: unknown, next: (e?: unknown) => void, res: Response) => {
  if (err instanceof DiagnosticBundleError) {
    res.status(err.statusCode).json({ success: false, error: err.code, message: err.message });
    return;
  }
  next(err);
};

/** Collect a signed diagnostic bundle (loan, events, txs, notifications, audit, scores). */
router.get(
  '/diagnostics/bundles/:loanId',
  requireJwtAuth,
  requireRoles('admin'),
  requireScopes('admin:diagnostics'),
  strictRateLimiter,
  async (req, res, next) => {
    try {
      const loanId = Number(req.params.loanId);
      const signed = await diagnostics().collectLoanBundle(
        loanId,
        (req as unknown as { user?: { publicKey: string } }).user?.publicKey ?? 'admin',
      );
      res.json({ success: true, ...signed });
    } catch (err) {
      handleDiagnosticError(err, next, res);
    }
  },
);

/** Raw XDR + submission parameters for re-submission via Stellar Laboratory. */
router.get(
  '/diagnostics/replay/:transactionId',
  requireJwtAuth,
  requireRoles('admin'),
  requireScopes('admin:diagnostics'),
  strictRateLimiter,
  async (req, res, next) => {
    try {
      const replay = await diagnostics().getReplayData(String(req.params.transactionId));
      res.json({ success: true, ...replay });
    } catch (err) {
      handleDiagnosticError(err, next, res);
    }
  },
const onboardAssetSchema = z.object({
  assetCode: z.string().regex(/^[A-Za-z0-9]{1,12}$/),
  issuer: z.string().regex(/^G[A-Z2-7]{55}$/),
  tokenAddress: z.string().regex(/^C[A-Z2-7]{55}$/),
  decimals: z.number().int().min(0).max(18),
  minLoanAmount: z.string().regex(/^\d+$/),
  maxLoanAmount: z.string().regex(/^\d+$/),
});

/**
 * @swagger
 * /admin/assets:
 *   post:
 *     summary: Onboard a Stellar asset onto the loan/pool allowlist
 *     tags: [Admin]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [assetCode, issuer, tokenAddress, decimals, minLoanAmount, maxLoanAmount]
 *             properties:
 *               assetCode: { type: string, example: USDC }
 *               issuer: { type: string, description: Stellar issuer account (G...) }
 *               tokenAddress: { type: string, description: Soroban token contract (C...) }
 *               decimals: { type: integer, minimum: 0, maximum: 18 }
 *               minLoanAmount: { type: string, description: Smallest unit, integer string }
 *               maxLoanAmount: { type: string, description: Smallest unit, integer string }
 *     responses:
 *       201:
 *         description: Asset onboarded
 *       400:
 *         description: Validation error or asset already onboarded
 */
router.post(
  '/assets',
  requireJwtAuth,
  requireRoles('admin'),
  auditLog,
  validateBody(onboardAssetSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof onboardAssetSchema>;
    if (BigInt(body.maxLoanAmount) < BigInt(body.minLoanAmount)) {
      throw AppError.badRequest('maxLoanAmount must be >= minLoanAmount');
    }
    const asset = await createSupportedAsset(body);
    res.status(201).json({ success: true, asset });
  }),
);

router.get('/audit-logs', requireJwtAuth, requireRoles('admin'), listAuditLogs);

/**
 * @swagger
 * /admin/audit-logs/export:
 *   get:
 *     summary: Stream audit log entries as NDJSON with their HMAC chain fields
 *     tags: [Admin]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date-time }
 *     responses:
 *       200:
 *         description: NDJSON stream (application/x-ndjson), one entry per line
 */
router.get('/audit-logs/export', requireJwtAuth, requireRoles('admin'), exportAuditLogs);

/**
 * @swagger
 * /admin/audit-logs/verify:
 *   post:
 *     summary: Verify the tamper-evident HMAC chain over a time range
 *     tags: [Admin]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               from: { type: string, format: date-time }
 *               to: { type: string, format: date-time }
 *     responses:
 *       200:
 *         description: pass/fail with the first broken link, if any
 */
router.post('/audit-logs/verify', requireJwtAuth, requireRoles('admin'), auditLog, verifyAuditLogs);
router.get(
  '/abuse-telemetry',
  requireJwtAuth,
  requireRoles('admin'),
  asyncHandler(getAbuseTelemetryReport),
);

router.post(
  '/loans/:loanId/build-reject',
  requireJwtAuth,
  requireRoles('admin'),
  auditLog,
  buildRejectLoanTx,
);
/**
 * @swagger
 * /admin/loan-disputes:
 *   get:
 *     summary: List open loan disputes
 *     tags: [Admin]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: List of open disputes
 *
 * /admin/loan-disputes/{disputeId}/resolve:
 *   post:
 *     summary: Resolve a loan dispute (confirm or reverse default)
 *     tags: [Admin]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: disputeId
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - action
 *               - resolution
 *             properties:
 *               action:
 *                 type: string
 *                 enum: [confirm, reverse]
 *                 description: Action to take on the dispute
 *               resolution:
 *                 type: string
 *                 description: Detailed reason for resolution (minimum 5 characters)
 *               adminNote:
 *                 type: string
 *                 description: Optional admin note visible to borrower
 *     responses:
 *       200:
 *         description: Dispute resolved and borrower notified
 *       400:
 *         description: Validation error
 */
router.get('/loan-disputes', requireApiKey('admin:disputes'), listLoanDisputes);
router.post(
  '/loan-disputes/:disputeId/resolve',
  requireApiKey('admin:disputes'),
  resolveLoanDispute,
);
// New admin JWT-protected endpoints
router.get('/disputes', requireJwtAuth, requireRoles('admin'), listLoanDisputes);
router.get('/disputes/:disputeId', requireJwtAuth, requireRoles('admin'), getLoanDispute);
router.post(
  '/disputes/:disputeId/resolve',
  requireJwtAuth,
  requireRoles('admin'),
  resolveLoanDispute,
);
router.post(
  '/disputes/:disputeId/review',
  requireJwtAuth,
  requireRoles('admin'),
  reviewLoanDispute,
);
router.post(
  '/disputes/:disputeId/reject',
  requireJwtAuth,
  requireRoles('admin'),
  rejectLoanDispute,
);

router.get('/governance/pending', requireJwtAuth, requireRoles('admin'), getPendingGovernance);

/**
 * @swagger
 * /admin/contracts/verification-status:
 *   get:
 *     summary: Stellar explorer verification status for deployed contracts
 *     tags: [Admin]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Aggregate verification stats and per-contract status
 */
router.get(
  '/contracts/verification-status',
  requireJwtAuth,
  requireRoles('admin'),
  getContractVerificationStatus,
);

/**
 * @swagger
 * /admin/contract-verification:
 *   get:
 *     summary: Last WASM hash integrity verification result per deployed contract
 *     tags: [Admin]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Per-contract WASM hash verification results
 */
router.get(
  '/contract-verification',
  requireJwtAuth,
  requireRoles('admin'),
  getContractVerification,
);

const checkDefaultsBodySchema = z.object({
  loanIds: z
    .array(z.number().int().positive())
    .max(1000, 'max 1000 loan IDs per request')
    .optional(),
});

/**
 * @swagger
 * /admin/check-defaults:
 *   post:
 *     summary: Trigger manual on-chain default checks for a set of loans
 *     description: >
 *       Calls the LoanManager `check_defaults` contract function for the
 *       provided loan IDs (or all overdue loans if IDs are omitted).
 *       Bounded to a maximum of 1000 IDs per request for security.
 *     tags: [Admin]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               loanIds:
 *                 type: array
 *                 items:
 *                   type: integer
 *                 maxItems: 1000
 *                 description: Explicit list of loan IDs to check
 *     responses:
 *       200:
 *         description: Default check run completed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/DefaultCheckRunResult'
 *       400:
 *         description: Validation error or too many IDs
 */
router.post(
  '/check-defaults',
  requireApiKey('admin:loans'),
  strictRateLimiter,
  auditLog,
  validateBody(checkDefaultsBodySchema),
  asyncHandler(async (req, res) => {
    const result = await defaultChecker.checkOverdueLoans(req.body.loanIds);
    res.json(result);
  }),
);

/**
 * @swagger
 * /admin/loans/{loanId}/replay-state:
 *   get:
 *     summary: Reconstruct loan state by replaying its event log
 *     description: >
 *       Admin endpoint (issue #75) that rebuilds a loan's current state by
 *       replaying its append-only loan state events. Returns the folded
 *       snapshot and the full ordered event list for auditability.
 *     tags: [Admin]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: loanId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Reconstructed loan state
 *       400:
 *         description: Invalid loan ID
 */
router.get('/loans/:loanId/replay-state', requireApiKey('admin:loans'), replayLoanStateEndpoint);

/**
 * @swagger
 * /admin/loans/{loanId}/state-events:
 *   get:
 *     summary: List raw loan state events
 *     description: >
 *       Returns the append-only loan state events for a loan in chronological
 *       order, supporting `?limit=` and `?beforeId=` cursor pagination.
 *     tags: [Admin]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: loanId
 *         required: true
 *         schema:
 *           type: integer
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *       - in: query
 *         name: beforeId
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Loan state events retrieved
 *       400:
 *         description: Invalid loan ID
 */
router.get(
  '/loans/:loanId/state-events',
  requireApiKey('admin:loans'),
  listLoanStateEventsEndpoint,
);

/**
 * @swagger
 * /admin/reindex:
 *   post:
 *     summary: Backfill/reindex contract events for a ledger range
 *     tags: [Admin]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: fromLedger
 *         required: true
 *         schema:
 *           type: integer
 *       - in: query
 *         name: toLedger
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Reindex completed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ReindexResponse'
 */
router.post(
  '/reindex',
  requireApiKey('admin:indexer'),
  strictRateLimiter,
  auditLog,
  reindexLedgerRange,
);

/**
 * @swagger
 * /admin/quarantine-events:
 *   get:
 *     summary: List quarantined indexer events
 *     tags: [Admin]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         required: false
 *         schema:
 *           type: integer
 *           default: 50
 *       - in: query
 *         name: cursor
 *         required: false
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Quarantined events retrieved
 */
router.get('/quarantine-events', requireApiKey('admin:indexer'), listQuarantinedEvents);

/**
 * @swagger
 * /admin/quarantine-events/reprocess:
 *   post:
 *     summary: Reprocess quarantined indexer events
 *     tags: [Admin]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               ids:
 *                 type: array
 *                 items:
 *                   type: integer
 *               limit:
 *                 type: integer
 *                 default: 50
 *     responses:
 *       200:
 *         description: Reprocess attempt completed
 */
router.post(
  '/quarantine-events/reprocess',
  requireApiKey('admin:indexer'),
  strictRateLimiter,
  auditLog,
  reprocessQuarantinedEvents,
);

/**
 * @swagger
 * /admin/webhooks:
 *   post:
 *     summary: Register a webhook subscription
 *     tags: [Admin]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [callbackUrl, eventTypes]
 *             properties:
 *               callbackUrl:
 *                 type: string
 *               eventTypes:
 *                 type: array
 *                 items:
 *                   type: string
 *               secret:
 *                 type: string
 *     responses:
 *       201:
 *         description: Subscription created
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/WebhookSubscriptionResponse'
 */
router.post(
  '/webhooks',
  requireJwtAuth,
  requireScopes('write:webhooks'),
  strictRateLimiter,
  auditLog,
  createWebhookSubscription,
);

/**
 * @swagger
 * /admin/webhooks:
 *   get:
 *     summary: List webhook subscriptions
 *     tags: [Admin]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: List of subscriptions
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/WebhookSubscriptionListResponse'
 */
router.get('/webhooks', requireJwtAuth, requireScopes('read:webhooks'), listWebhookSubscriptions);

/**
 * @swagger
 * /admin/webhooks/{id}:
 *   delete:
 *     summary: Remove a webhook subscription
 *     tags: [Admin]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Subscription deleted
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SuccessMessageResponse'
 */
router.delete(
  '/webhooks/:id',
  requireJwtAuth,
  requireScopes('write:webhooks'),
  strictRateLimiter,
  auditLog,
  deleteWebhookSubscription,
);

router.put(
  '/webhooks/:id',
  requireJwtAuth,
  requireScopes('write:webhooks'),
  strictRateLimiter,
  auditLog,
  updateWebhookSubscription,
);
router.get(
  '/webhooks/:id/audit',
  requireJwtAuth,
  requireScopes('read:webhooks'),
  getWebhookSubscriptionAudit,
);

/**
 * @swagger
 * /admin/webhooks/{id}/deliveries:
 *   get:
 *     summary: View webhook delivery history
 *     tags: [Admin]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *       - in: query
 *         name: limit
 *         required: false
 *         schema:
 *           type: integer
 *           default: 50
 *     responses:
 *       200:
 *         description: Delivery history returned
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/WebhookDeliveriesResponse'
 */
router.get(
  '/webhooks/:id/deliveries',
  requireJwtAuth,
  requireScopes('read:webhooks'),
  getWebhookDeliveries,
);

/**
 * @swagger
 * /admin/webhooks/retry-status:
 *   get:
 *     summary: Get status of failed webhooks and retry queue
 *     tags: [Admin]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Retry status information
 */
router.get(
  '/webhooks/retry-status',
  requireApiKey('admin:webhooks'),
  asyncHandler(async (_req, res) => {
    const result = await query(`
      SELECT 
        COUNT(*) as total_failed,
        COUNT(*) FILTER (WHERE attempt_count >= 5) as permanently_failed,
        COUNT(*) FILTER (WHERE next_retry_at IS NOT NULL) as pending_retry
      FROM webhook_deliveries
      WHERE delivered_at IS NULL
    `);

    res.json(result.rows[0]);
  }),
);

/**
 * @swagger
 * /admin/webhooks/dead-letters:
 *   get:
 *     summary: List dead-lettered webhook deliveries (redacted)
 *     tags: [Admin]
 *     responses:
 *       200:
 *         description: Dead-lettered deliveries
 */
router.get(
  '/webhooks/dead-letters',
  requireJwtAuth,
  requireRoles('admin'),
  asyncHandler(listWebhookDeadLetters),
);

/**
 * @swagger
 * /admin/webhooks/deliveries/{deliveryId}/redrive:
 *   post:
 *     summary: Re-drive a dead-lettered webhook delivery
 *     description: Takes no body. Target URL and payload cannot be changed.
 *     tags: [Admin]
 *     responses:
 *       202:
 *         description: Delivery re-queued with an incremented generation
 *       409:
 *         description: Delivery is not dead-lettered
 */
router.post(
  '/webhooks/deliveries/:deliveryId/redrive',
  requireJwtAuth,
  requireRoles('admin'),
  strictRateLimiter,
  auditLog,
  asyncHandler(redriveWebhookDelivery),
);

/**
 * @swagger
 * /admin/discrepancies:
 *   get:
 *     summary: Read-only view of the reconciliation discrepancy ledger
 *     tags: [Admin]
 *     responses:
 *       200:
 *         description: Discrepancy records
 */
router.get(
  '/discrepancies',
  requireJwtAuth,
  requireRoles('admin'),
  asyncHandler(async (req, res) => {
    const limit = Number(req.query.limit);
    const rows = await listDiscrepancies({
      ...(typeof req.query.status === 'string' ? { status: req.query.status } : {}),
      ...(typeof req.query.severity === 'string' ? { severity: req.query.severity } : {}),
      ...(typeof req.query.type === 'string' ? { type: req.query.type } : {}),
      ...(Number.isInteger(limit) && limit > 0 ? { limit } : {}),
    });
    res.json({ success: true, data: { discrepancies: rows } });
  }),
);

router.get(
  '/discrepancies/export',
  requireJwtAuth,
  requireRoles('admin'),
  asyncHandler(async (req, res) => {
    const csv = await exportDiscrepanciesCSV({
      ...(typeof req.query.startDate === 'string' ? { startDate: req.query.startDate } : {}),
      ...(typeof req.query.endDate === 'string' ? { endDate: req.query.endDate } : {}),
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="discrepancies.csv"');
    res.send(csv);
  }),
);

router.post(
  '/discrepancies/:id/acknowledge',
  requireJwtAuth,
  requireRoles('admin'),
  strictRateLimiter,
  asyncHandler(async (req, res) => {
    const note = req.body?.note || req.body?.reason || 'Acknowledged by operator';
    const result = await acknowledgeDiscrepancy({
      discrepancyId: Number(req.params.id),
      actor: req.user!.publicKey,
      note,
    });
    res.json({ success: true, data: result });
  }),
);

const resolveDiscrepancySchema = z.object({
  reason: z.string().min(10),
  evidence: z.record(z.string(), z.unknown()),
});

/**
 * @swagger
 * /admin/discrepancies/{id}/resolve:
 *   post:
 *     summary: Request resolution of a discrepancy (dual control, no financial correction)
 *     description: >
 *       Creates a privileged action request; a second admin must approve it and
 *       it must then be executed via /admin/privileged-actions/{id}/execute.
 *     tags: [Admin]
 *     responses:
 *       202:
 *         description: Approval request created
 */
router.post(
  '/discrepancies/:id/resolve',
  requireJwtAuth,
  requireRoles('admin'),
  // Separate credential from the read-only view: resolution needs the scoped key too.
  requireApiKey('admin:reconciliation'),
  strictRateLimiter,
  validateBody(resolveDiscrepancySchema),
  asyncHandler(async (req, res) => {
    const created = await createPrivilegedRequest({
      actionType: 'reconciliation_resolution',
      payload: {
        discrepancyId: Number(req.params.id),
        reason: req.body.reason,
        evidence: req.body.evidence,
      },
      initiator: req.user!.publicKey,
    });
    res.status(202).json({ success: true, data: created });
  }),
);

/**
 * @swagger
 * /admin/reconciliation/status:
 *   get:
 *     summary: Last cross-contract reconciliation run (time, duration, divergence count)
 *     tags: [Admin]
 *     responses:
 *       200:
 *         description: Reconciler status
 */
router.get(
  '/reconciliation/status',
  requireJwtAuth,
  requireRoles('admin'),
  requireApiKey('admin:reconciliation'),
  asyncHandler(async (_req, res) => {
    res.json({ success: true, data: await getReconciliationStatus() });
  }),
);

const createPrivilegedActionSchema = z.object({
  actionType: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
});
const approvePrivilegedActionSchema = z.object({ payloadHash: z.string().length(64) });

const privilegedId = (value: string | undefined): number => {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw AppError.badRequest('Invalid request id');
  return id;
};

/**
 * @swagger
 * /admin/privileged-actions:
 *   post:
 *     summary: Open a dual-control request for a high-impact action
 *     tags: [Admin]
 *     responses:
 *       202:
 *         description: Request created; a different admin must approve it
 */
router.post(
  '/privileged-actions',
  requireJwtAuth,
  requireRoles('admin'),
  strictRateLimiter,
  validateBody(createPrivilegedActionSchema),
  asyncHandler(async (req, res) => {
    const created = await createPrivilegedRequest({
      actionType: req.body.actionType,
      payload: req.body.payload,
      initiator: req.user!.publicKey,
    });
    res.status(202).json({ success: true, data: created });
  }),
);

router.get(
  '/privileged-actions/:id',
  requireJwtAuth,
  requireRoles('admin'),
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: await getPrivilegedRequest(privilegedId(req.params.id)) });
  }),
);

router.post(
  '/privileged-actions/:id/approve',
  requireJwtAuth,
  requireRoles('admin'),
  strictRateLimiter,
  validateBody(approvePrivilegedActionSchema),
  asyncHandler(async (req, res) => {
    await approvePrivilegedRequest(
      privilegedId(req.params.id),
      req.user!.publicKey,
      req.body.payloadHash,
    );
    res.json({ success: true });
  }),
);

router.post(
  '/privileged-actions/:id/revoke',
  requireJwtAuth,
  requireRoles('admin'),
  strictRateLimiter,
  asyncHandler(async (req, res) => {
    await revokePrivilegedRequest(privilegedId(req.params.id), req.user!.publicKey);
    res.json({ success: true });
  }),
);

router.post(
  '/privileged-actions/:id/execute',
  requireJwtAuth,
  requireRoles('admin'),
  strictRateLimiter,
  asyncHandler(async (req, res) => {
    const result = await executePrivilegedRequest(privilegedId(req.params.id), req.user!.publicKey);
    res.status(result.status === 'executed' ? 200 : 502).json({ success: true, data: result });
  }),
);

/**
 * @swagger
 * /admin/alerts/ownership:
 *   get:
 *     summary: List SLO alert ownership and escalation mappings
 *     description: >
 *       Returns the owner, severity, runbook, and escalation route for every
 *       critical SLO alert. Read-only; requires the admin role.
 *     tags: [Admin]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Alert ownership mappings
 *       403:
 *         description: Caller is not an admin
 */
router.get(
  '/alerts/ownership',
  requireJwtAuth,
  requireRoles('admin'),
  asyncHandler(getAlertOwnership),
// ---------------------------------------------------------------------------
// Signed evidence provenance (#848) — admin read-only endpoints.
// Writes are performed internally by ingestion jobs; no public POST endpoint
// prevents injecting fabricated evidence from outside the trust boundary.
// ---------------------------------------------------------------------------

/**
 * @swagger
 * /admin/evidence-provenance/meta:
 *   get:
 *     summary: Supported record types and verification result values
// Signed operator recovery actions (#866)
// ---------------------------------------------------------------------------

const createRecoveryActionSchema = z.object({
  action_type: z.enum([
    'reconciliation_retry',
    'reconciliation_resolve',
    'cross_contract_reconcile',
    'loan_state_replay',
    'loan_event_retry',
  ]),
  reason_code: z.enum([
    'indexer_lag',
    'contract_event_missed',
    'db_write_failure',
    'duplicate_event',
    'stale_snapshot',
    'manual_reconciliation',
    'operator_requested',
  ]),
  /** Minimum 3 chars; external ticket or dual-approval request ID. */
  approval_reference: z.string().min(3),
  /**
   * HMAC-SHA256 hex of
   * `${operator_id}|${action_type}|${idempotency_key}|${canonical_payload}`
   * keyed with the operator's admin:recovery API key.
   */
  operator_signature: z
    .string()
    .regex(/^[0-9a-f]{64}$/, 'operator_signature must be a 64-character lowercase hex string'),
  /** Schema-validated action payload; no arbitrary balance fields allowed. */
  payload: z.record(z.string(), z.unknown()),
  /** Free-text justification, min 10 chars. */
  reason_note: z.string().min(10),
  /**
   * Optional: idempotency_key may also be supplied in the request body when
   * the client cannot set the Idempotency-Key header; the middleware-supplied
   * header value takes precedence.
   */
  idempotency_key: z.string().optional(),
});

const rejectRecoverySchema = z.object({
  reason: z.string().min(5),
});

/**
 * @swagger
 * /admin/recovery-actions/meta:
 *   get:
 *     summary: Supported action types and reason codes for recovery actions
 *     tags: [Admin]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Evidence provenance metadata
 */
router.get(
  '/evidence-provenance/meta',
  requireJwtAuth,
  requireRoles('admin'),
  getEvidenceMetaHandler,
 *         description: Metadata for recovery action creation
 */
router.get(
  '/recovery-actions/meta',
  requireJwtAuth,
  requireRoles('admin'),
  getRecoveryMetaHandler,
// ── Network submission telemetry + bounded failover (#857) ────────────────
// Operator-only surfaces for per-network throughput / latency / throttle /
// error rates, bounded failover state, durable failover + retry-storm events,
// and dead-letter re-drive. Gated by the admin:indexer API key.

/**
 * @swagger
 * /admin/network-telemetry:
 *   get:
 *     summary: Per-network transaction submission telemetry + bounded failover status
 *     description: >
 *       Throughput, latency (p50/p95/p99), throttle rate, and error rate per
 *       configured network endpoint, plus the active failover endpoint,
 *       per-endpoint circuit state, durable write-queue depth, dead-letter
 *       count, and the current retry-storm alert state.
 *     tags: [Admin]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Telemetry + failover snapshot
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: object
 *                   properties:
 *                     telemetry:
 *                       type: object
 *                       description: Per-network rates + write-queue + storm-alert state
 *                     failover:
 *                       type: object
 *                       description: Per-endpoint circuit state + active selection
 */
router.get('/network-telemetry', requireApiKey('admin:indexer'), getNetworkTelemetry);

/**
 * @swagger
 * /admin/network-failover/events:
 *   get:
 *     summary: Recent failover + retry-storm audit events
 *     tags: [Admin]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         required: false
 *         schema: { type: integer, default: 50, maximum: 200 }
 *     responses:
 *       200:
 *         description: Failover / storm events (newest first)
 */
router.get(
  '/network-failover/events',
  requireApiKey('admin:indexer'),
  getNetworkFailoverEvents,
// ── Secure deletion of cached financial projections (#853) ────────────────────

/**
 * @swagger
 * /admin/cache/projections/{userId}:
 *   delete:
 *     summary: Securely delete all cached financial projections for a user
 *     description: >
 *       Deletes every Redis key that backs a user-visible financial projection
 *       for the given wallet address, including versioned SWR score keys, legacy
 *       key formats, on-chain score history, NFT metadata, and borrower loan
 *       aggregates. The authoritative source of truth (database / chain) is
 *       never modified.
 *
 *       Returns 200 when all keys are confirmed deleted. Returns 207 when at
 *       least one key deletion could not be confirmed (Redis unreachable) — in
 *       that case the response body contains per-key outcomes and the
 *       authoritative data remains correct.
 *
 *       Sets `Cache-Invalidation-Token: projections:{userId}` on the response
 *       so the browser-side read cache can evict matching in-memory entries.
 *     tags: [Admin]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *         description: Stellar wallet address of the subject
 *     responses:
 *       200:
 *         description: All projection cache keys confirmed deleted
 *         headers:
 *           Cache-Invalidation-Token:
 *             schema:
 *               type: string
 *             description: Comma-separated eviction tokens for browser caches
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ProjectionDeletionResult'
 *       207:
 *         description: Partial deletion — Redis unreachable for one or more keys
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ProjectionDeletionResult'
 *       400:
 *         description: Invalid userId
 *       401:
 *         description: Missing or invalid JWT
 *       403:
 *         description: Caller does not have admin role
 */
router.delete(
  '/cache/projections/:userId',
  requireJwtAuth,
  requireRoles('admin'),
  strictRateLimiter,
  auditLog,
  deleteUserProjectionCache,
);

/**
 * @swagger
 * /admin/alerts/ownership:
 *   put:
 *     summary: Replace SLO alert ownership and escalation mappings
 *     description: >
 *       Validates the full mapping set (unique alert keys, known severities,
 *       non-empty owner/runbook/escalation route) and persists it atomically.
 *       Invalid input is rejected with 400 and no partial write occurs.
 *     tags: [Admin]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Updated alert ownership mappings
 *       400:
 *         description: Validation error
 *       403:
 *         description: Caller is not an admin
 */
router.put(
  '/alerts/ownership',
 * /admin/evidence-provenance:
 *   get:
 *     summary: List evidence provenance records
 *     description: >
 *       Returns a paginated, immutable list of evidence provenance records.
 *       Supports filtering by record_type, source_identity, and verification_result.
 *       Use cursor (ISO timestamp) for keyset pagination.
 *     tags: [Admin]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Evidence provenance records
 */
router.get(
  '/evidence-provenance',
  requireJwtAuth,
  requireRoles('admin'),
  listEvidenceHandler,
 * /admin/cache/projections:
 *   delete:
 *     summary: Bulk-delete cached financial projections for multiple users
 *     description: >
 *       Deletes all projection cache keys for each userId in the request body.
 *       At most 100 subjects per request. Subjects are processed in parallel;
 *       failure for one subject does not abort the others.
 *     tags: [Admin]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [userIds]
 *             properties:
 *               userIds:
 *                 type: array
 *                 items:
 *                   type: string
 *                 maxItems: 100
 *     responses:
 *       200:
 *         description: All keys confirmed deleted
 *       207:
 *         description: Partial deletion — some Redis keys unconfirmed
 *       400:
 *         description: Validation error
 *       403:
 *         description: Caller does not have admin role
 */
router.delete(
  '/cache/projections',
  requireJwtAuth,
  requireRoles('admin'),
  strictRateLimiter,
  auditLog,
  validateBody(alertOwnershipUpdateSchema),
  asyncHandler(updateAlertOwnership),
  bulkDeleteUserProjectionCache,
);

/**
 * @swagger
 * /admin/alerts/drills:
 *   post:
 *     summary: Start a scheduled alert notification drill
 *     description: >
 *       Sends test notifications for the selected alerts and records the drill
 *       so acknowledgement and recovery can be measured. Requires an
 *       Idempotency-Key header; replaying the same key returns the original
 *       drill. A duplicate drill for the same alert set returns 409.
 *     tags: [Admin]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       202:
 *         description: Drill started
 *       400:
 *         description: Validation error
 *       403:
 *         description: Caller is not an admin
 *       409:
 *         description: Duplicate drill for the same alert set
 */
router.post(
  '/alerts/drills',
  requireJwtAuth,
  requireRoles('admin'),
  strictRateLimiter,
  idempotency,
  auditLog,
  validateBody(alertDrillSchema),
  asyncHandler(startAlertDrill),
 * /admin/network-failover/dead-letters:
 *   get:
 *     summary: List dead-lettered signed writes (metadata only)
 *     description: >
 *       Returns bounded retry exhaustion metadata for signed writes that the
 *       replay processor could not submit. Signed XDR payloads are deliberately
 *       excluded; re-drive is the only supported mutation.
 *     tags: [Admin]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         required: false
 *         schema: { type: integer, default: 50, maximum: 200 }
 *     responses:
 *       200:
 *         description: Dead-lettered writes, newest first
 * /admin/cache/projections/revoke:
 *   post:
 *     summary: Revoke cached projections with an explicit compliance reason
 *     description: >
 *       Identical to DELETE but writes a REVOKE audit record with an explicit
 *       reason string so compliance tools can filter revocations from routine
 *       invalidations independently.
 *     tags: [Admin]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [userId, reason]
 *             properties:
 *               userId:
 *                 type: string
 *               reason:
 *                 type: string
 *                 maxLength: 500
 *     responses:
 *       200:
 *         description: Projections revoked and audit record written
 *       207:
 *         description: Partial deletion — Redis unreachable for some keys
 *       400:
 *         description: Validation error
 *       403:
 *         description: Caller does not have admin role
 */
router.post(
  '/cache/projections/revoke',
  requireJwtAuth,
  requireRoles('admin'),
  strictRateLimiter,
  auditLog,
  revokeUserProjectionCache,
);

/**
 * @swagger
 * /admin/evidence-provenance/{id}:
 *   get:
 *     summary: Get a single evidence provenance record
 *     tags: [Admin]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Evidence record
 *       404:
 *         description: Not found
 */
router.get(
  '/evidence-provenance/:id',
  requireJwtAuth,
  requireRoles('admin'),
  getEvidenceHandler,
 * /admin/recovery-actions:
 *   get:
 *     summary: List operator recovery actions
 *     description: >
 *       Returns a paginated, immutable list of all operator recovery action
 *       records. Supports filtering by operator_id, action_type, status, and
 *       approval_reference. Use cursor (last seen id) for keyset pagination.
 *     tags: [Admin]
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Recovery action records
 */
router.get(
  '/recovery-actions',
  requireJwtAuth,
  requireRoles('admin'),
  listRecoveryActionsHandler,
);

/**
 * @swagger
 * /admin/incidents/{incidentId}/bundle:
 *   post:
 *     summary: Create a time-limited incident evidence bundle
 *     description: >
 *       Collects bounded request, trace, checkpoint, and state references with
 *       redaction by default. Requires an Idempotency-Key header; replaying the
 *       same key returns the original bundle.
 * /admin/evidence-provenance/{id}/verify:
 *   get:
 *     summary: Verify the HMAC integrity of a stored evidence record
 *     description: >
 *       Re-computes the row HMAC and returns { valid: true/false }.
 *       A false result means the row was tampered with after insertion.
 *     tags: [Admin]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Verification result
 */
router.get(
  '/evidence-provenance/:id/verify',
  requireJwtAuth,
  requireRoles('admin'),
  verifyEvidenceHandler,
 * /admin/recovery-actions:
 *   post:
 *     summary: Submit a signed operator recovery action
 *     description: >
 *       Creates an immutable recovery action record. The operator MUST supply
 *       an HMAC-SHA256 signature (operator_signature) keyed with their
 *       admin:recovery scoped API key, an external approval_reference, a
 *       bounded reason_code, and an Idempotency-Key header.
 *
 *       Arbitrary balance edits are rejected — no payload field that maps to a
 *       direct financial mutation is accepted.
 *     tags: [Admin]
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 * /admin/cache/projections/{userId}/verify:
 *   get:
 *     summary: Verify no stale projection cache remains for a user
 *     description: >
 *       Read-only check: returns `verified: true` when no projection keys
 *       survive in Redis, or `verified: false` with the list of surviving keys
 *       when stale entries remain after a deletion attempt.
 *       This endpoint is idempotent and performs no deletions.
 *     tags: [Admin]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: incidentId
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       201:
 *         description: Bundle created
 *       400:
 *         description: Validation error
 *       403:
 *         description: Caller is not an admin
 *       404:
 *         description: Unknown incident
 */
router.post(
  '/incidents/:incidentId/bundle',
  requireJwtAuth,
  requireRoles('admin'),
  strictRateLimiter,
  idempotency,
  auditLog,
  validateBody(incidentBundleCreateSchema),
  asyncHandler(createIncidentEvidenceBundle),
 *       200:
 *         description: Verification result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: object
 *                   properties:
 *                     deadLetters: { type: array, items: { type: object } }
 */
router.get(
  '/network-failover/dead-letters',
  requireApiKey('admin:indexer'),
  listDeadLetterWrites,
);

/**
 * @swagger
 * /admin/network-failover/dead-letters/{id}/redrive:
 *   post:
 *     summary: Re-drive a dead-lettered signed write for another bounded retry pass
 *     description: >
 *       Only a write currently in the `dead_lettered` state may be re-driven;
 *       the immutable signed payload is unchanged. Resets attempts and clears
 *       dead-letter state so the replay processor drains it. The signed XDR
 *       and transaction hash are never altered, preserving on-chain money
 *       semantics.
 *     tags: [Admin]
 *     security:
 *       - ApiKeyAuth: []
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     subject:
 *                       type: string
 *                     survivingKeys:
 *                       type: array
 *                       items:
 *                         type: string
 *                     verified:
 *                       type: boolean
 *       400:
 *         description: Invalid userId
 *       403:
 *         description: Caller does not have admin role
 */
router.get(
  '/cache/projections/:userId/verify',
  requireJwtAuth,
  requireRoles('admin'),
  verifyUserProjectionDeletion,
);

export default router;


// Webhook consumer certification endpoints (#768)
const consumerCertifications = new Map<string, any>();

router.post(
  '/webhooks/consumers/:id/certify',
  requireJwtAuth,
  requireRoles('admin'),
  strictRateLimiter,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const checklist = req.body || {};
    const record = {
      consumerId: id,
      certified: true,
      certifiedAt: new Date().toISOString(),
      certifiedBy: req.user?.publicKey || 'admin',
      checklist: {
        hmacVerification: Boolean(checklist.hmacVerification),
        retryHandling: Boolean(checklist.retryHandling),
        idempotency: Boolean(checklist.idempotency),
        tls: Boolean(checklist.tls),
      },
    };
    consumerCertifications.set(id, record);
    res.status(200).json({ success: true, data: record });
  }),
);

router.get(
  '/webhooks/consumers/:id/certification',
  requireJwtAuth,
  requireRoles('admin'),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const record = consumerCertifications.get(id) || {
      consumerId: id,
      certified: false,
      status: 'uncertified',
    };
    res.json({ success: true, data: record });
  }),
// ── Break-glass emergency access (issue #849) ────────────────────────────
// Mounts all break-glass routes under /admin/break-glass (and v1 equivalent).
router.use('/', breakGlassRoutes);

// ── Cryptographic erasure (#847) ─────────────────────────────────────────────

/**
 * @swagger
 * /admin/erasure:
 *   post:
 *     summary: Admin-initiated erasure request on behalf of a user
 *     tags: [Admin, Erasure]
// ── Threat-model refresh gate (#856) ─────────────────────────────────────────

/**
 * @swagger
 * /admin/threat-model/reviews:
 *   post:
 *     summary: Initiate an annual threat-model review for a trust boundary
 *     description: >
 *       Starts a draft review. A second admin must call /approve before it
 *       counts as a current review and unblocks the production release gate.
 *       Duplicate drafts by the same reviewer for the same boundary are rejected.
 *     tags: [Admin, ThreatModel]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - action_type
 *               - reason_code
 *               - approval_reference
 *               - operator_signature
 *               - payload
 *               - reason_note
 *             properties:
 *               action_type:
 *                 type: string
 *                 enum:
 *                   - reconciliation_retry
 *                   - reconciliation_resolve
 *                   - cross_contract_reconcile
 *                   - loan_state_replay
 *                   - loan_event_retry
 *               reason_code:
 *                 type: string
 *                 enum:
 *                   - indexer_lag
 *                   - contract_event_missed
 *                   - db_write_failure
 *                   - duplicate_event
 *                   - stale_snapshot
 *                   - manual_reconciliation
 *                   - operator_requested
 *               approval_reference:
 *                 type: string
 *                 minLength: 3
 *               operator_signature:
 *                 type: string
 *                 pattern: '^[0-9a-f]{64}$'
 *               payload:
 *                 type: object
 *               reason_note:
 *                 type: string
 *                 minLength: 10
 *     responses:
 *       201:
 *         description: Recovery action created
 *       400:
 *         description: Validation error or balance-edit detected
 *       401:
 *         description: Operator signature verification failed
 *       409:
 *         description: Duplicate idempotency_key
 */
router.post(
  '/recovery-actions',
  requireJwtAuth,
  requireRoles('admin'),
  requireApiKey('admin:recovery'),
  strictRateLimiter,
  auditLog,
  validateBody(createRecoveryActionSchema),
  createRecoveryActionHandler,
 *             required: [user_public_key, reason]
 *             properties:
 *               user_public_key:
 *                 type: string
 *               reason:
 *                 type: string
 *                 enum: [right_to_erasure, account_closure, gdpr_article_17, ccpa_deletion, other]
 *               consent_ref:
 *             required: [boundary, document_hash]
 *             properties:
 *               boundary:
 *                 type: string
 *                 enum: [wallet, provider, api, contract, infra]
 *               document_hash:
 *                 type: string
 *                 description: SHA-256 hex of the threat-model document content
 *               mitigations:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [id, description, status]
 *               approval_ref:
 *                 type: string
 *                 nullable: true
 *     responses:
 *       202:
 *         description: Request queued
 *       409:
 *         description: Duplicate or active financial obligation
 */
router.post(
  '/erasure',
 *         description: Review draft created
 *       409:
 *         description: Duplicate draft for this boundary + reviewer
 */
router.post(
  '/threat-model/reviews',
  requireJwtAuth,
  requireRoles('admin'),
  strictRateLimiter,
  auditLog,
  asyncHandler(adminInitiateErasure),
  asyncHandler(initiateReview),
);

/**
 * @swagger
 * /admin/incidents/{incidentId}/bundle:
 *   get:
 *     summary: Retrieve an incident evidence bundle
 *     description: >
 *       Access-controlled and time-limited. Returns 404 for an unknown
 *       incident and 410 once the bundle has expired.
 *     tags: [Admin]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: incidentId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Bundle contents
 *       403:
 *         description: Caller is not an admin
 *       404:
 *         description: Unknown incident or bundle
 *       410:
 *         description: Bundle has expired
 */
router.get(
  '/incidents/:incidentId/bundle',
  requireJwtAuth,
  requireRoles('admin'),
  asyncHandler(getIncidentEvidenceBundle),
 * /admin/recovery-actions/{id}:
 *   get:
 *     summary: Get a single recovery action record
 *     tags: [Admin]
 *     security:
 *       - BearerAuth: []
 * /admin/erasure:
 *   get:
 *     summary: List erasure requests
 *     tags: [Admin, Erasure]
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [pending, in_progress, completed, failed, rejected] }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50 }
 *       - in: query
 *         name: cursor
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Paginated list
 */
router.get('/erasure', requireJwtAuth, requireRoles('admin'), asyncHandler(listErasureRequests));

/**
 * @swagger
 * /admin/erasure/{id}:
 *   get:
 *     summary: Get a single erasure request
 *     tags: [Admin, Erasure]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Recovery action record
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Write re-queued for replay
 *       404:
 *         description: Dead-lettered write not found
 */
router.post(
  '/network-failover/dead-letters/:id/redrive',
  requireApiKey('admin:indexer'),
  strictRateLimiter,
  auditLog,
  redriveDeadLetterWrite,
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Erasure request
 *       404:
 *         description: Not found
 */
router.get(
  '/recovery-actions/:id',
  requireJwtAuth,
  requireRoles('admin'),
  getRecoveryActionHandler,
  '/erasure/:id',
  requireJwtAuth,
  requireRoles('admin'),
  asyncHandler(getErasureRequest),
);

/**
 * @swagger
 * /admin/clock-skew:
 *   get:
 *     summary: Report measured service and provider clock drift
 *     description: >
 *       Returns the authoritative timestamp per workflow plus measured drift
 *       for each service and provider, and flags any that exceed the alert
 *       threshold.
 *     tags: [Admin]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Clock skew report
 *       403:
 *         description: Caller is not an admin
 */
router.get(
  '/clock-skew',
  requireJwtAuth,
  requireRoles('admin'),
  asyncHandler(getClockSkewReport),
);

export default router;
 * /admin/recovery-actions/{id}/execute:
 *   post:
 *     summary: Execute an approved recovery action
 *     description: >
 *       Transitions the action from pending → executing → completed/failed
 *       exactly once. A concurrent or replayed call returns 409.
 *     tags: [Admin]
 *     security:
 *       - BearerAuth: []
 *       - ApiKeyAuth: []
 * /admin/erasure/{id}/execute:
 *   post:
 *     summary: Execute a pending erasure — null PII, zero DEKs, revoke KEK, issue certificate
 *     description: >
 *       Idempotent guard: completed/in-progress requests are rejected.
 *       Returns the verifiable erasure certificate on success.
 *     tags: [Admin, Erasure]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       201:
 *         description: Erasure executed; certificate issued
 *       409:
 *         description: Request already completed or in-progress
 *       404:
 *         description: Request not found
 */
router.post(
  '/erasure/:id/execute',
 * /admin/threat-model/reviews/{id}/approve:
 *   post:
 *     summary: Approve a draft threat-model review (second-admin gate)
 *     description: >
 *       Self-approval is blocked. Approving a review automatically supersedes
 *       any older approved reviews for the same boundary.
 *     tags: [Admin, ThreatModel]
 *     responses:
 *       200:
 *         description: Review approved; now counts as current for 365 days
 *       403:
 *         description: Self-approval attempt
 *       409:
 *         description: Review not in draft state
 */
router.post(
  '/threat-model/reviews/:id/approve',
  requireJwtAuth,
  requireRoles('admin'),
  strictRateLimiter,
  auditLog,
  asyncHandler(approveReview),
);

/** @swagger
 * /admin/threat-model/reviews:
 *   get:
 *     summary: List threat-model reviews (filterable by boundary, status)
 *     tags: [Admin, ThreatModel]
 */
router.get('/threat-model/reviews', requireJwtAuth, requireRoles('admin'), asyncHandler(listReviews));

/** @swagger
 * /admin/threat-model/reviews/current:
 *   get:
 *     summary: Current approved review for every boundary
 *     tags: [Admin, ThreatModel]
 */
router.get(
  '/threat-model/reviews/current',
  requireJwtAuth,
  requireRoles('admin'),
  asyncHandler(getCurrentReviews),
);

/** @swagger
 * /admin/threat-model/reviews/{id}:
 *   get:
 *     summary: Single threat-model review with days_until_expiry
 *     tags: [Admin, ThreatModel]
 */
router.get('/threat-model/reviews/:id', requireJwtAuth, requireRoles('admin'), asyncHandler(getReview));

/**
 * @swagger
 * /admin/threat-model/changes:
 *   post:
 *     summary: Record a trust-boundary change (from CI or manually)
 *     description: >
 *       Checks whether a current review exists for the boundary.
 *       Returns 403 (gate_status=gated) when no current review exists.
 *       Returns 201 (gate_status=passed) when a current review exists.
 *       Admin can force-override with force=true + force_reason (audited).
 *     tags: [Admin, ThreatModel]
 *     responses:
 *       201:
 *         description: Change recorded; gate passed or forced
 *       403:
 *         description: No current threat-model review — gate blocked
 */
router.post(
  '/threat-model/changes',
  requireJwtAuth,
  requireRoles('admin'),
  strictRateLimiter,
  auditLog,
  asyncHandler(executeErasure),
);

/**
 * @swagger
 * /admin/erasure/{id}/certificate:
 *   get:
 *     summary: Fetch and verify the erasure certificate
 *     description: >
 *       Re-computes the SHA-256 hash over the stored JSON fields and returns
 *       hash_verified: true when the certificate has not been tampered with.
 *     tags: [Admin, Erasure]
 *     responses:
 *       200:
 *         description: Certificate with hash_verified flag
 *       404:
 *         description: No certificate for this request
 */
router.get(
  '/erasure/:id/certificate',
  requireJwtAuth,
  requireRoles('admin'),
  asyncHandler(getErasureCertificate),
);

export default router;

// ── Config integrity monitoring (#854) ───────────────────────────────────────

/**
 * @swagger
 * /admin/config-changes:
 *   post:
 *     summary: Record a privileged configuration change
 *     description: >
 *       Appends an immutable record of a config change. When no approval_ref
 *       is supplied the change is flagged as 'unauthorized' and an alert is
 *       dispatched to configured channels. Never modifies existing records.
 *     tags: [Admin, ConfigIntegrity]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [config_key, new_value]
 *             properties:
 *               config_key:
 *                 type: string
 *                 example: "loan.interest_rate_percent"
 *               prior_value:
 *                 description: Value before this change (null for initial write)
 *               new_value:
 *                 description: Value after this change
 *               approval_ref:
 *                 type: string
 *                 nullable: true
 *                 description: Dual-control approval reference (privileged_action_requests.id or ticket)
 *               source:
 *                 type: string
 *                 enum: [api, direct, recovery, contract]
 *               effective_at:
 *                 type: string
 *                 format: date-time
 *               requires_approval:
 *                 type: boolean
 *                 default: true
 *     responses:
 *       201:
 *         description: Change recorded
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 */
router.post(
  '/config-changes',
  requireJwtAuth,
  requireRoles('admin'),
  strictRateLimiter,
  auditLog,
  recordChange,
);

/**
 * @swagger
 * /admin/config-changes:
 *   get:
 *     summary: List privileged configuration changes
 *     tags: [Admin, ConfigIntegrity]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: config_key
 *         schema: { type: string }
 *       - in: query
 *         name: actor
 *         schema: { type: string }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [applied, unauthorized, recovered] }
 *       - in: query
 *         name: source
 *         schema: { type: string, enum: [api, direct, recovery, contract] }
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50, maximum: 200 }
 *       - in: query
 *         name: cursor
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Paginated list of changes
 */
router.get('/config-changes', requireJwtAuth, requireRoles('admin'), listChanges);

/**
 * @swagger
 * /admin/config-changes/{id}:
 *   get:
 *     summary: Get a single config change record
 *     tags: [Admin, ConfigIntegrity]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Recovery action completed
 *       409:
 *         description: Already executed or in a non-executable state
 *       502:
 *         description: Execution failed; see outcome_error in response body
 */
router.post(
  '/recovery-actions/:id/execute',
  requireJwtAuth,
  requireRoles('admin'),
  requireApiKey('admin:recovery'),
  strictRateLimiter,
  auditLog,
  executeRecoveryActionHandler,
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Change record
 *       404:
 *         description: Not found
 */
router.get('/config-changes/:id', requireJwtAuth, requireRoles('admin'), getChange);

/**
 * @swagger
 * /admin/config-changes/{id}/recover:
 *   post:
 *     summary: Recover a config key to a reviewed snapshot value
 *     description: >
 *       Requires a reviewed snapshot and a valid approval reference. Records
 *       a new change log row with source='recovery'. All prior active rows
 *       for the key are marked 'recovered'; originals are never deleted.
 *     tags: [Admin, ConfigIntegrity]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [snapshot_id, approval_ref]
 *             properties:
 *               snapshot_id:
 *                 type: string
 *                 format: uuid
 *               approval_ref:
 *                 type: string
 *     responses:
 *       201:
 *         description: Recovery applied and new change row created
 *       400:
 *         description: Snapshot not reviewed or validation error
 *       404:
 *         description: Snapshot not found
 */
router.post(
  '/config-changes/:id/recover',
  requireJwtAuth,
  requireRoles('admin'),
  strictRateLimiter,
  auditLog,
  recoverChange,
);

/**
 * @swagger
 * /admin/recovery-actions/{id}/reject:
 *   post:
 *     summary: Reject (cancel) a pending recovery action
 *     tags: [Admin]
 * /admin/config-snapshots:
 *   post:
 *     summary: Capture a reviewed configuration snapshot
 *     description: >
 *       Saves the current (or supplied) value of a config key as a snapshot
 *       that can later be used as a recovery target. Set is_reviewed=true
 *       only after a second admin has verified the value.
 *     tags: [Admin, ConfigIntegrity]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [config_key, value]
 *             properties:
 *               config_key:
 *                 type: string
 *               value:
 *                 description: The value to snapshot
 *               review_ref:
 *                 type: string
 *                 nullable: true
 *               is_reviewed:
 *                 type: boolean
 *                 default: false
 *     responses:
 *       201:
 *         description: Snapshot created
 */
router.post(
  '/config-snapshots',
  requireJwtAuth,
  requireRoles('admin'),
  strictRateLimiter,
  auditLog,
  createSnapshot,
);

/**
 * @swagger
 * /admin/config-snapshots/{id}/review:
 *   put:
 *     summary: Mark a snapshot as reviewed (second-admin approval)
 *     tags: [Admin, ConfigIntegrity]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [reason]
 *             properties:
 *               reason:
 *                 type: string
 *                 minLength: 5
 *     responses:
 *       200:
 *         description: Recovery action rejected
 *       409:
 *         description: Action is not in pending state
 */
router.post(
  '/recovery-actions/:id/reject',
 *             properties:
 *               review_ref:
 *                 type: string
 *     responses:
 *       200:
 *         description: Snapshot marked reviewed
 *       404:
 *         description: Not found
 */
router.put(
  '/config-snapshots/:id/review',
  requireJwtAuth,
  requireRoles('admin'),
  strictRateLimiter,
  auditLog,
  validateBody(rejectRecoverySchema),
  rejectRecoveryActionHandler,
);

export default router;

  reviewSnapshot,
);

/**
 * @swagger
 * /admin/config-snapshots:
 *   get:
 *     summary: List configuration snapshots
 *     tags: [Admin, ConfigIntegrity]
 *     parameters:
 *       - in: query
 *         name: config_key
 *         schema: { type: string }
 *       - in: query
 *         name: is_reviewed
 *         schema: { type: boolean }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50, maximum: 200 }
 *     responses:
 *       200:
 *         description: List of snapshots
 */
router.get('/config-snapshots', requireJwtAuth, requireRoles('admin'), listSnapshots);

export default router;
  asyncHandler(recordChange),
);

/** @swagger
 * /admin/threat-model/changes:
 *   get:
 *     summary: Change inventory (filterable by boundary, gate_status)
 *     tags: [Admin, ThreatModel]
 */
router.get('/threat-model/changes', requireJwtAuth, requireRoles('admin'), asyncHandler(listChanges));

/**
 * @swagger
 * /admin/threat-model/gate-check:
 *   post:
 *     summary: Run the gate check for a list of changed file paths
 *     description: >
 *       Classifies each path against the boundary pattern map and checks
 *       whether a current review exists for each touched boundary.
 *       Returns 200 when all boundaries pass; 403 when any boundary is gated.
 *     tags: [Admin, ThreatModel]
 *     responses:
 *       200:
 *         description: All touched boundaries have current reviews
 *       403:
 *         description: One or more boundaries lack a current review
 */
router.post(
  '/threat-model/gate-check',
  requireJwtAuth,
  requireRoles('admin'),
  strictRateLimiter,
  asyncHandler(runGateCheck),
// ── Orphaned transaction reconciliation (issue #858) ──────────────────────

/**
 * GET /api/v1/admin/transactions/reconciliation
 * Lists all orphaned-tx reconciliation records with optional state filter.
 */
router.get(
  '/transactions/reconciliation',
  requireApiKey('admin:reconciliation'),
  listTransactionReconciliations,
);

/**
 * POST /api/v1/admin/transactions/reconciliation/:id/resolve
 * Manually resolves a reconciliation record. Requires a resolution note.
 */
router.post(
  '/transactions/reconciliation/:id/resolve',
  requireApiKey('admin:reconciliation'),
  strictRateLimiter,
  resolveOrphanedTransaction,
);
