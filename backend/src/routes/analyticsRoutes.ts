import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { requireJwtAuth, requireRoles } from '../middleware/jwtAuth.js';
import { validateQuery } from '../middleware/validation.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { createSwrCacheMiddleware } from '../middleware/swrCacheMiddleware.js';
import { CacheKeys } from '../utils/cacheKeys.js';
import { ANALYTICS_BUCKETS, computeProtocolStats, computeExceptionSummary } from '../services/analyticsService.js';

const router = Router();

export const PROTOCOL_STATS_FRESH_TTL_SECONDS = 300;

const querySchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  bucket: z.enum(ANALYTICS_BUCKETS).default('day'),
});

/** Resolve a request's window; defaults to the last 30 days, rounded to the minute for cache reuse. */
export function resolveWindow(q: { from?: string; to?: string; bucket?: string }) {
  const minute = 60_000;
  const to = q.to ? new Date(q.to) : new Date(Math.floor(Date.now() / minute) * minute);
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - 30 * 24 * 3600 * 1000);
  return { from, to, bucket: (q.bucket ?? 'day') as (typeof ANALYTICS_BUCKETS)[number] };
}

const protocolStatsRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
  skip: () => process.env.NODE_ENV === 'test',
});

const protocolStatsCache = createSwrCacheMiddleware({
  key: (req) => {
    const { from, to, bucket } = resolveWindow(req.query as Record<string, string>);
    return CacheKeys.protocolStats(from.toISOString(), to.toISOString(), bucket);
  },
  compute: (req) => {
    const { from, to, bucket } = resolveWindow(req.query as Record<string, string>);
    return computeProtocolStats(from, to, bucket);
  },
  version: 1,
  freshTtl: PROTOCOL_STATS_FRESH_TTL_SECONDS,
  staleTtl: PROTOCOL_STATS_FRESH_TTL_SECONDS * 2,
});

/**
 * @swagger
 * /analytics/protocol-stats:
 *   get:
 *     summary: Protocol-wide aggregated metrics
 *     description: >
 *       Returns loans by status, time-bucketed origination/repayment volume, default rate by
 *       corridor and credit score distribution. Cached with stale-while-revalidate (5 min).
 *       Rate limited to 10 requests/minute per IP.
 *     tags: [Analytics]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: bucket
 *         schema: { type: string, enum: [day, week, month], default: day }
 *     responses:
 *       200:
 *         description: Protocol statistics
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 loansByStatus: { type: object, additionalProperties: { type: integer } }
 *                 volumeByBucket:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       timestamp: { type: string, format: date-time }
 *                       totalOriginated: { type: string }
 *                       totalRepaid: { type: string }
 *                 defaultRateByCorridor: { type: object, additionalProperties: { type: number } }
 *                 scoreDistribution:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       bucket: { type: string }
 *                       count: { type: integer }
 *       429:
 *         description: Rate limit exceeded
 */
router.get(
  '/protocol-stats',
  protocolStatsRateLimiter,
  requireJwtAuth,
  validateQuery(querySchema),
  protocolStatsCache,
);

const exceptionsQuerySchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});

/**
 * @swagger
 * /analytics/exceptions:
 *   get:
 *     summary: Settlement and payout exceptions aggregated by source and age
 *     description: >
 *       Returns open/critical reconciliation discrepancies (settlement and payout
 *       exceptions) grouped by source and age bucket, plus a recent list. Read-only:
 *       no financial data is corrected. Permissioned to admins.
 *     tags: [Analytics]
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
 *         description: Exception summary
 */
router.get(
  '/exceptions',
  protocolStatsRateLimiter,
  requireJwtAuth,
  requireRoles('admin'),
  validateQuery(exceptionsQuerySchema),
  asyncHandler(async (req, res) => {
    const minute = 60_000;
    const to = req.query.to ? new Date(String(req.query.to)) : new Date(Math.floor(Date.now() / minute) * minute);
    const from = req.query.from ? new Date(String(req.query.from)) : new Date(to.getTime() - 30 * 24 * 3600 * 1000);
    const summary = await computeExceptionSummary(from, to);
    res.json(summary);
  }),
);

export default router;
