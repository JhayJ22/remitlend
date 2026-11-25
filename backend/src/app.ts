import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import compression from 'compression';
import helmet from 'helmet';
import dotenv from 'dotenv';
import { Sentry } from './config/sentry.js';
import { mountSwaggerDocs } from './config/swagger.js';

dotenv.config();
import pool from './db/connection.js';
import { cacheService } from './services/cacheService.js';
import { sorobanService } from './services/sorobanService.js';
import simulationRoutes from './routes/simulationRoutes.js';
import scoreRoutes from './routes/scoreRoutes.js';
import loanRoutes from './routes/loanRoutes.js';
import poolRoutes from './routes/poolRoutes.js';
import indexerRoutes from './routes/indexerRoutes.js';
import adminRoutes from './routes/adminRoutes.js';
import analyticsRoutes from './routes/analyticsRoutes.js';
import authRoutes from './routes/authRoutes.js';
import userRoutes from './routes/userRoutes.js';
import notificationsRoutes from './routes/notificationsRoutes.js';
import eventRoutes from './routes/eventRoutes.js';
import remittanceRoutes from './routes/remittanceRoutes.js';
import transactionRoutes from './routes/transactionRoutes.js';
import statementRoutes from './routes/statementRoutes.js';
import orphanedTxRoutes from './routes/orphanedTxRoutes.js';
import { registerStatusRoutes } from './routes/statusRoutes.js';
import internalRoutes from './routes/internalRoutes.js';
import { requireApiKey } from './middleware/auth.js';
import { globalRateLimiter } from './middleware/rateLimiter.js';
import { errorHandler } from './middleware/errorHandler.js';
import { metricsHandler, metricsMiddleware } from './middleware/metrics.js';
import { requestLogger } from './middleware/requestLogger.js';
import { requestDeadlineMiddleware } from './middleware/requestDeadline.js';
import { requestIdMiddleware } from './middleware/requestId.js';
import { traceContextMiddleware } from './middleware/traceContext.js';
import { cspHeadersMiddleware, cspNonceMiddleware } from './middleware/cspNonce.js';
import { idempotencyMiddleware } from './middleware/idempotency.js';
import { sorobanDegradationBanner } from './middleware/sorobanDegradationBanner.js';
import { shutdownCoordinator } from './middleware/shutdownHandler.js';
import { reportCSPViolation } from './controllers/cspReportController.js';
import { pauseGuard } from './middleware/pauseGuard.js';
import { deprecationHeadersMiddleware } from './middleware/deprecationHeaders.js';
import { cacheInvalidationHeaderMiddleware } from './middleware/cacheInvalidationHeader.js';
import { loadSheddingMiddleware } from './middleware/loadShedding.js';
import { asyncHandler } from './utils/asyncHandler.js';
import { AppError } from './errors/AppError.js';
import logger from './utils/logger.js';
import {
  checkNetworkReadiness,
  SUPPORTED_API_VERSION_MANIFEST,
} from './config/networkReadiness.js';
import {
  setupConnectionLeakDetection,
  shutdownConnectionLeakDetection,
  dbConnectionLeakDetector,
} from './middleware/dbConnectionLeakDetector.js';
import { buildCapacitySnapshot } from './services/capacityModel.js';
const app = express();

setupConnectionLeakDetection();

const isProduction = process.env.NODE_ENV === 'production';
const configuredFrontendUrl = process.env.FRONTEND_URL?.trim();

if (isProduction && !configuredFrontendUrl) {
  throw new Error('FRONTEND_URL environment variable is required in production');
}

// `CORS_ALLOWED_ORIGINS` is retained as a migration fallback while `FRONTEND_URL`
// becomes the primary documented config for the frontend origin.
const additionalAllowedOrigins = process.env.CORS_ALLOWED_ORIGINS
  ? process.env.CORS_ALLOWED_ORIGINS.split(',').map((origin) => origin.trim())
  : [];

const allowedOriginsList = [configuredFrontendUrl, ...additionalAllowedOrigins].filter(
  (origin): origin is string => Boolean(origin),
);

if (isProduction && allowedOriginsList.length === 0) {
  throw new Error('No allowed origins configured for CORS in production. Set FRONTEND_URL.');
}

if (isProduction && allowedOriginsList.some((origin) => origin.trim() === '*')) {
  throw new Error('Wildcard CORS origin "*" is not allowed in production. Use explicit origins.');
}

const normalizeOrigin = (value: string) => value.trim().replace(/\/+$/, '').toLowerCase();

const originMatchesPattern = (origin: string, pattern: string): boolean => {
  const normalizedOrigin = normalizeOrigin(origin);
  const normalizedPattern = normalizeOrigin(pattern);

  if (!normalizedPattern || normalizedPattern === '*') {
    return normalizedPattern === '*';
  }

  if (!normalizedPattern.includes('*')) {
    return normalizedOrigin === normalizedPattern;
  }

  const escapedPattern = normalizedPattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');

  return new RegExp(`^${escapedPattern}$`, 'i').test(normalizedOrigin);
};

const isOriginAllowed = (origin: string): boolean => {
  if (allowedOriginsList.some((pattern) => originMatchesPattern(origin, pattern))) {
    return true;
  }

  return !isProduction && devOrigins.has(origin);
};

// In non-production environments, additionally allow common localhost origins
// used during development. Without this, staging/preview deployments that run
// with NODE_ENV !== 'production' would blindly reflect every origin.
const devOrigins = new Set([
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
]);

app.use(cspNonceMiddleware);
app.use(
  helmet({
    contentSecurityPolicy: false,
    strictTransportSecurity: isProduction
      ? {
          maxAge: 31536000,
          includeSubDomains: true,
          preload: true,
        }
      : false,
  }),
);
app.use(cspHeadersMiddleware);

const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    if (!origin) {
      return callback(null, true);
    }

    if (isOriginAllowed(origin)) {
      return callback(null, true);
    }

    logger.warn('CORS origin rejected', { origin });
    return callback(AppError.forbidden('Origin is not allowed by CORS policy'));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'x-api-key',
    'x-request-id',
    'Idempotency-Key',
    // W3C Trace Context (#414): accepted from the wallet frontend and any
    // upstream gateway so browser- and edge-originated traces can be joined.
    'traceparent',
    'tracestate',
  ],
  exposedHeaders: ['x-request-id', 'traceparent', 'tracestate'],
  credentials: true,
};

app.use(cors(corsOptions));
app.use(compression());
// Explicit request body size limit set to 100kb to mitigate payload-based DoS and unbounded audit log writes.
// CSP reports (report-uri) arrive as `application/csp-report`, not plain JSON, so accept that type too.
app.use(express.json({ limit: '100kb', type: ['application/json', 'application/csp-report'] }));
app.use(globalRateLimiter);
app.use(loadSheddingMiddleware());
app.use(requestIdMiddleware);
app.use(requestDeadlineMiddleware);
// Trace context (#414): resolves/creates the W3C `traceparent` for the request
// after the request id so both correlation fields live in one async context.
app.use(traceContextMiddleware);
app.use(requestLogger);
app.use(metricsMiddleware);
// Graceful degradation (#74): flag read responses while the Soroban RPC circuit is open.
app.use(sorobanDegradationBanner);
app.use(dbConnectionLeakDetector);

// Shutdown coordinator: track in-flight requests and reject new ones during shutdown
app.use(shutdownCoordinator.middleware());

// Idempotency middleware: handle Idempotency-Key headers for all requests
// Ensures duplicate requests with the same key return cached responses
app.use(idempotencyMiddleware);

// Pause guard: reject state-mutating requests when contracts are paused
// Issue #1381: Cross-layer emergency pause coordination
app.use(pauseGuard);

// Cache invalidation header propagation (#853): ensure Cache-Invalidation-Token
// headers set by deletion endpoints survive compression and carry no-store
// directives so proxies do not cache projection-invalidating responses.
app.use(cacheInvalidationHeaderMiddleware);

app.post(
  '/api/v1/csp-report',
  asyncHandler(async (req: Request, res: Response) => reportCSPViolation(req, res)),
);

app.get('/', (_req: Request, res: Response) => {
  res.send('RemitLend Backend is running');
});

/**
 * GET /version
 *
 * Read-only endpoint for operators and runbooks.
 * Returns build metadata and on-chain contract IDs so that the exact
 * backend version deployed can be determined without shelling into the container.
 *
 * Environment variables (injected at Docker build time via ARG/ENV):
 *   GIT_SHA    — full git commit SHA of the build (falls back to "unknown")
 *   BUILD_TIME — ISO-8601 UTC timestamp of the build (falls back to "unknown")
 */
app.get('/version', (_req: Request, res: Response) => {
  res.json({
    gitSha: process.env.GIT_SHA ?? 'unknown',
    builtAt: process.env.BUILD_TIME ?? 'unknown',
    nodeVersion: process.version,
    contracts: {
      loanManager: process.env.LOAN_MANAGER_CONTRACT_ID ?? 'unknown',
      lendingPool: process.env.LENDING_POOL_CONTRACT_ID ?? 'unknown',
      remittanceNft: process.env.REMITTANCE_NFT_CONTRACT_ID ?? 'unknown',
      multisigGovernance: process.env.MULTISIG_GOVERNANCE_CONTRACT_ID ?? 'unknown',
    },
    supportedVersions: SUPPORTED_API_VERSION_MANIFEST,
  });
});

/**
 * GET /ready
 *
 * Kubernetes-style readiness probe — issue #862.
 *
 * Validates network passphrase, RPC endpoint, all contract IDs, asset issuer
 * metadata, and the supported-version manifest.  Returns:
 *   200  — ready to serve financial routes (no critical issues).
 *   503  — not ready (one or more critical issues found).
 *
 * Warning-level issues (e.g. optional asset issuers not configured) are
 * included in the response but do not change the HTTP status code.
 *
 * The live RPC probe is intentionally included so load balancers can detect
 * an RPC outage and route around the affected instance.  When
 * SOROBAN_REQUIRE_RPC_AT_STARTUP=true the RPC check is treated as critical.
 *
 * Response body shape:
 * {
 *   ready: boolean,
 *   healthy: boolean,
 *   durationMs: number,
 *   issues: Array<{ field: string, message: string, severity: "critical"|"warning" }>,
 *   versions: { minApiVersion: number, maxApiVersion: number, deprecatedVersions: number[] }
 * }
 *
 * No secret values are exposed in any field of this response.
 */
app.get(
  '/ready',
  asyncHandler(async (_req: Request, res: Response) => {
    const result = await checkNetworkReadiness();

    const body = {
      ready: result.ready,
      healthy: result.healthy,
      durationMs: result.durationMs,
      issues: result.issues,
      versions: SUPPORTED_API_VERSION_MANIFEST,
    };

    res.status(result.ready ? 200 : 503).json(body);
  }),
);

app.get(
  '/health',
  asyncHandler(async (_req: Request, res: Response) => {
    const [databaseStatus, redisStatus, sorobanStatus] = await Promise.allSettled([
      pool
        .query('SELECT 1')
        .then(() => 'ok' as const)
        .catch(() => 'error' as const),
      cacheService.ping(),
      sorobanService.ping(),
    ]);

    const dbChecks = {
      database: databaseStatus.status === 'fulfilled' ? databaseStatus.value : 'error',
      redis: redisStatus.status === 'fulfilled' ? redisStatus.value : 'error',
    };

    const checks = {
      api: 'ok' as const,
      ...dbChecks,
      soroban_rpc: sorobanStatus.status === 'fulfilled' ? sorobanStatus.value : 'error',
    };

    const coreOk = Object.values(dbChecks).every((c) => c === 'ok');
    const allOk = coreOk && checks.soroban_rpc === 'ok';

    res.status(coreOk ? 200 : 503).json({
      status: allOk ? 'ok' : coreOk ? 'degraded' : 'down',
      checks,
      uptime: process.uptime(),
      timestamp: Date.now(),
    });
  }),
);

/**
 * GET /healthz/ready
 *
 * Readiness probe used by the blue-green deploy gate (#797) and load
 * balancers: 200 only when this instance can serve traffic (DB + Redis
 * reachable within 2s). Soroban RPC is intentionally excluded so a chain RPC
 * blip does not flip every slot out of rotation.
 */
app.get(
  '/healthz/ready',
  asyncHandler(async (_req: Request, res: Response) => {
    const TIMEOUT_MS = 2000;
    const withTimeout = <T>(p: Promise<T>, fallback: T): Promise<T> =>
      Promise.race([
        p,
        new Promise<T>((resolve) => setTimeout(() => resolve(fallback), TIMEOUT_MS)),
      ]);

    const [database, redis] = await Promise.all([
      withTimeout(
        pool
          .query('SELECT 1')
          .then(() => 'ok' as const)
          .catch(() => 'error' as const),
        'error' as const,
      ),
      withTimeout(
        cacheService.ping().catch(() => 'error' as const),
        'error' as const,
      ),
    ]);

    const ready = database === 'ok' && redis === 'ok';
    res.setHeader('Cache-Control', 'no-store');
    res.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'not_ready',
      checks: { database, redis },
    });
  }),
);

/**
 * GET /metrics
 *
 * Prometheus metrics endpoint exposing operational and business metrics.
 * Requires admin:indexer API key.
 *
 * Metrics exposed:
 * - Request metrics: http_request_duration_seconds (request latency by method, route, status)
 * - Database metrics: db_query_duration_seconds (query latency by operation, table)
 * - Cache metrics: cache_hits_total, cache_misses_total (by key pattern)
 * - Loan metrics: loan_approvals_total, loan_rejections_total, active_loans_total
 * - Pool metrics: pool_utilization_ratio (utilization % by pool_id)
 * - Transaction metrics: transaction_processing_time_seconds (on-chain latency by type)
 * - Indexer metrics: indexer_last_ledger, indexer_chain_tip, indexer_lag_ledgers
 * - System metrics: process_*, nodejs_* (default prom-client metrics)
 */
app.get('/metrics', requireApiKey('admin:indexer'), asyncHandler(metricsHandler));

/**
 * GET /capacity
 *
 * On-demand capacity model snapshot — issue #865.
 *
 * Returns a point-in-time forecast of database storage, connection demand,
 * and Redis memory, plus retention headroom and scale threshold crossings.
 * Requires admin:indexer API key (same gate as /metrics).
 *
 * Query parameters:
 *   forecastDays  (integer, default 30) — projection horizon.
 *
 * Response body:
 * {
 *   capturedAt: ISO string,
 *   forecastDays: number,
 *   overallThresholdLevel: "ok" | "warn" | "critical",
 *   tables: [ { table, rowCount, estimatedBytes, projectedBytes,
 *                retentionDays, eligibleForPurge, thresholdLevel } ],
 *   totalDbEstimatedBytes: number,
 *   totalDbProjectedBytes: number,
 *   connectionDemand: { peakConnections, projectedPeakConnections,
 *                        connectionUtilizationRatio, thresholdLevel },
 *   redisMemoryModel: { totalBytesEstimate, projectedBytesEstimate },
 *   thresholds: { tableStorageWarnBytes, tableStorageCriticalBytes, ... }
 * }
 *
 * No secret values, no user-identifying data, and no financial amounts are
 * included in any field of this response.
 */
app.get(
  '/capacity',
  requireApiKey('admin:indexer'),
  asyncHandler(async (req: Request, res: Response) => {
    const rawDays = req.query['forecastDays'];
    const forecastDays = typeof rawDays === 'string' && /^\d+$/.test(rawDays)
      ? Math.min(Math.max(Number.parseInt(rawDays, 10), 1), 365)
      : 30;

    const snapshot = await buildCapacitySnapshot(forecastDays);
    res.json(snapshot);
  }),
);

/**
 * GET /health/deep
 * Exercises DB, Redis, Stellar RPC, and indexer lag.
 * Returns 200 when all green, 503 when any dependency is down,
 * 200 with status "degraded" when indexer lag exceeds INDEXER_HEALTH_LAG_LIMIT.
 */
app.get(
  '/health/deep',
  asyncHandler(async (_req: Request, res: Response) => {
    const TIMEOUT_MS = 2000;
    const INDEXER_HEALTH_LAG_LIMIT = Number.parseInt(
      process.env.INDEXER_HEALTH_LAG_LIMIT ?? '100',
      10,
    );

    const withTimeout = <T>(promise: Promise<T>, fallback: T): Promise<T> =>
      Promise.race([
        promise,
        new Promise<T>((resolve) => setTimeout(() => resolve(fallback), TIMEOUT_MS)),
      ]);

    const [dbResult, redisResult, rpcResult, indexerResult] = await Promise.allSettled([
      withTimeout(
        pool
          .query('SELECT 1')
          .then(() => ({ status: 'ok' as const }))
          .catch(() => ({ status: 'down' as const })),
        { status: 'down' as const },
      ),
      withTimeout(
        cacheService.ping().then((r) => ({
          status: r === 'ok' ? ('ok' as const) : ('down' as const),
        })),
        { status: 'down' as const },
      ),
      withTimeout(
        sorobanService.healthCheck().then((r) => ({
          status: r.connected ? ('ok' as const) : ('down' as const),
          latestLedger: r.latestLedger,
        })),
        { status: 'down' as const, latestLedger: undefined },
      ),
      withTimeout(
        pool
          .query('SELECT last_indexed_ledger FROM indexer_state ORDER BY id DESC LIMIT 1')
          .then((r) => ({
            lastIndexedLedger: r.rows[0]?.last_indexed_ledger ?? null,
          }))
          .catch(() => ({ lastIndexedLedger: null })),
        { lastIndexedLedger: null },
      ),
    ]);

    const db = dbResult.status === 'fulfilled' ? dbResult.value.status : 'down';
    const redis = redisResult.status === 'fulfilled' ? redisResult.value.status : 'down';
    const rpcData =
      rpcResult.status === 'fulfilled'
        ? rpcResult.value
        : { status: 'down' as const, latestLedger: undefined };
    const stellarRpc = rpcData.status;
    const rpcLedger = (rpcData as { latestLedger?: number }).latestLedger;

    const indexerData =
      indexerResult.status === 'fulfilled' ? indexerResult.value : { lastIndexedLedger: null };
    const lagLedgers =
      rpcLedger != null && indexerData.lastIndexedLedger != null
        ? rpcLedger - Number(indexerData.lastIndexedLedger)
        : null;
    const indexerStatus =
      lagLedgers === null
        ? ('down' as const)
        : lagLedgers > INDEXER_HEALTH_LAG_LIMIT
          ? ('degraded' as const)
          : ('ok' as const);

    const anyDown = db === 'down' || redis === 'down' || stellarRpc === 'down';
    const overallStatus = anyDown ? 'down' : indexerStatus === 'degraded' ? 'degraded' : 'ok';

    res.status(anyDown ? 503 : 200).json({
      status: overallStatus,
      checks: {
        db,
        redis,
        stellarRpc,
        indexer: {
          status: indexerStatus,
          lagLedgers,
        },
      },
      timestamp: Date.now(),
    });
  }),
);

// Status routes - public endpoints (available without authentication)
const statusRouter = express.Router();
registerStatusRoutes(statusRouter);
app.use('/', statusRouter);

// Legacy routes (deprecated, maintained for backward compatibility)
// All /api/* routes include deprecation headers directing clients to /api/v1/*
app.use('/api', deprecationHeadersMiddleware);
app.use('/api', simulationRoutes);
app.use('/api/score', scoreRoutes);
app.use('/api/loans', loanRoutes);
app.use('/api/pool', poolRoutes);
app.use('/api/indexer', indexerRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/remittances', remittanceRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/statements', statementRoutes);

// Orphaned transaction reconciliation routes (issue #858)
app.use('/api/transactions', orphanedTxRoutes);

// Versioned API routes (v1 - current)
app.use('/api/v1', simulationRoutes);
app.use('/api/v1/score', scoreRoutes);
app.use('/api/v1/loans', loanRoutes);
app.use('/api/v1/indexer', indexerRoutes);
app.use('/api/v1/admin', adminRoutes);
app.use('/api/v1/analytics', analyticsRoutes);
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/remittances', remittanceRoutes);
app.use('/api/v1/transactions', transactionRoutes);

// Orphaned transaction reconciliation routes (issue #858)
app.use('/api/v1/transactions', orphanedTxRoutes);
app.use('/api/v1/pool', poolRoutes);
app.use('/api/v1/notifications', notificationsRoutes);
app.use('/api/v1/events', eventRoutes);
app.use('/api/v1/statements', statementRoutes);
app.use('/user', userRoutes);
app.use('/users', userRoutes);
app.use('/api/v1/users', userRoutes);

// Internal service-to-service routes (HMAC-signed only)
app.use('/api/internal', internalRoutes);

mountSwaggerDocs(app);

// ── Diagnostic / Test Routes ─────────────────────────────────────
// Only exposed in test environment to verify centralized error handling.
if (process.env.NODE_ENV === 'test') {
  app.get('/test/error/operational', () => {
    throw AppError.badRequest('Diagnostic operational error');
  });

  app.get('/test/error/internal', () => {
    throw AppError.internal('Diagnostic internal error');
  });

  app.get('/test/error/unexpected', () => {
    throw new Error('Diagnostic unexpected exception');
  });

  app.get(
    '/test/error/async',
    asyncHandler(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      throw new Error('Diagnostic async exception');
    }),
  );
}

// ── 404 Catch-All ────────────────────────────────────────────────
// Must be placed after all route definitions so that only truly
// unmatched paths trigger a not-found error.
// Express 5 uses path-to-regexp v8 which requires named params,
// so we use a standard middleware function instead of app.all('*').
app.use((req: Request, _res: Response, next: NextFunction) => {
  next(AppError.notFound(`Cannot ${req.method} ${req.path}`));
});

// ── Sentry Error Handler ──────────────────────────────────────────
// Must be registered after all routes so it captures errors forwarded
// via next(err), but before the custom errorHandler so Sentry sees them.
Sentry.setupExpressErrorHandler(app);

// ── Global Error Handler ─────────────────────────────────────────
// Must be the LAST middleware registered so it catches every error
// forwarded via next(err) from routes and other middleware.
app.use(errorHandler);

export default app;

process.on('SIGTERM', () => {
  shutdownConnectionLeakDetection();
});

process.on('SIGINT', () => {
  shutdownConnectionLeakDetection();
});
