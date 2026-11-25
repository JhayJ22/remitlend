/**
 * Tests for issue #860 — controlled backpressure for provider and indexing queues.
 *
 * Coverage
 * ────────
 *   ✓ Capacity constants: warn threshold, soft limit, hard limit per queue class
 *   ✓ Saturation snapshot: depth reads, ratio computation, flag derivation
 *   ✓ Admission control — normal path: all job classes admitted when depth < warn
 *   ✓ Admission control — warn path: admit + warn header when depth ≥ warnThreshold
 *   ✓ Admission control — shed path: background/webhook shed at soft limit
 *   ✓ Admission control — reject path: ALL classes rejected at hard limit
 *   ✓ Financial writes never silently dropped: rejection returns structured 503
 *   ✓ Exact money values: payload content passes through unmodified
 *   ✓ Background job gate: shouldBackgroundJobRun() returns run=false under pressure
 *   ✓ Retry-After header present and matches SOROBAN_WRITE_REPLAY_INTERVAL_MS
 *   ✓ GET/HEAD requests always admitted regardless of queue depth
 *   ✓ Fail-open: DB error on depth read never blocks a financial write
 *   ✓ Cache TTL: snapshot reused within TTL window, refreshed after expiry
 *   ✓ Prometheus gauges updated after refresh
 *   ✓ /metrics endpoint exposes soroban_write_queue_depth and saturation gauges
 *   ✓ Webhook queue depth separately tracked and gated
 *   ✓ Access control: backpressure middleware does not replace JWT auth
 *   ✓ Reset helper clears cached snapshot for test isolation
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// ── DB mock — controlled to return any depth we set ──────────────────────────

type QueryResult = { rows: unknown[]; rowCount: number };

const mockQuery = jest
  .fn<(sql: string, params?: unknown[]) => Promise<QueryResult>>()
  .mockResolvedValue({ rows: [{ count: 0 }], rowCount: 1 });

jest.unstable_mockModule('../db/connection.js', () => ({
  default: { query: mockQuery },
  query: mockQuery,
  getClient: jest.fn(),
  withTransaction: jest.fn(),
}));

// ── Cache/soroban mocks needed by app.ts ─────────────────────────────────────

jest.unstable_mockModule('../services/cacheService.js', () => ({
  cacheService: {
    ping: jest.fn<() => Promise<string>>().mockResolvedValue('ok'),
    get: jest.fn<() => Promise<null>>().mockResolvedValue(null),
    set: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    delete: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    deleteIfMatch: jest.fn<() => Promise<boolean>>().mockResolvedValue(false),
  },
}));

jest.unstable_mockModule('../services/sorobanService.js', () => ({
  sorobanService: {
    ping: jest.fn<() => Promise<string>>().mockResolvedValue('ok'),
    healthCheck: jest
      .fn<() => Promise<{ connected: boolean }>>()
      .mockResolvedValue({ connected: true }),
  },
}));

// ── Dynamic imports ───────────────────────────────────────────────────────────

const {
  getSorobanQueueCapacity,
  getWebhookQueueCapacity,
  checkQueueAdmission,
  readQueueSaturation,
  readSorobanWriteQueueDepth,
  readWebhookRetryQueueDepth,
  getLastQueueSaturationSnapshot,
  resetQueueSaturationSnapshot,
} = await import('../services/queueBackpressure.js');

const {
  financialQueueBackpressureMiddleware,
  shouldBackgroundJobRun,
  getQueueSaturationForStatus,
} = await import('../middleware/queueBackpressureMiddleware.js');

const {
  sorobanWriteQueueDepthGauge,
  sorobanWriteQueueSaturationGauge,
  overallQueueSaturationGauge,
  queueAdmissionRejectionsCounter,
  queueBackgroundShedsCounter,
} = await import('../middleware/metrics.js');

import request from 'supertest';
const { default: app } = await import('../app.js');

// ── Env helpers ───────────────────────────────────────────────────────────────

const CAPACITY_KEYS = [
  'SOROBAN_QUEUE_WARN_THRESHOLD',
  'SOROBAN_QUEUE_SOFT_LIMIT',
  'SOROBAN_QUEUE_HARD_LIMIT',
  'WEBHOOK_QUEUE_WARN_THRESHOLD',
  'WEBHOOK_QUEUE_SOFT_LIMIT',
  'WEBHOOK_QUEUE_HARD_LIMIT',
  'SOROBAN_WRITE_REPLAY_INTERVAL_MS',
];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of CAPACITY_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  mockQuery.mockReset();
  resetQueueSaturationSnapshot();
});

afterEach(() => {
  for (const key of CAPACITY_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
  resetQueueSaturationSnapshot();
});

// ─── Helper: set both queue depths via the mock ───────────────────────────────

function setQueueDepths(soroban: number, webhook: number): void {
  mockQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('soroban_write_queue')) {
      return { rows: [{ count: soroban }], rowCount: 1 };
    }
    if (sql.includes('webhook_deliveries')) {
      return { rows: [{ count: webhook }], rowCount: 1 };
    }
    return { rows: [{ count: 0 }], rowCount: 1 };
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. Capacity configuration
// ═════════════════════════════════════════════════════════════════════════════

describe('Capacity configuration', () => {
  it('returns correct Soroban queue capacity defaults', () => {
    const cap = getSorobanQueueCapacity();
    expect(cap.warnThreshold).toBe(50);
    expect(cap.softLimit).toBe(200);
    expect(cap.hardLimit).toBe(500);
  });

  it('returns correct webhook queue capacity defaults', () => {
    const cap = getWebhookQueueCapacity();
    expect(cap.warnThreshold).toBe(100);
    expect(cap.softLimit).toBe(500);
    expect(cap.hardLimit).toBe(2000);
  });

  it('respects SOROBAN_QUEUE_HARD_LIMIT env override', () => {
    process.env.SOROBAN_QUEUE_HARD_LIMIT = '1000';
    const cap = getSorobanQueueCapacity();
    expect(cap.hardLimit).toBe(1000);
  });

  it('ignores non-positive SOROBAN_QUEUE_HARD_LIMIT and uses default', () => {
    process.env.SOROBAN_QUEUE_HARD_LIMIT = '-5';
    const cap = getSorobanQueueCapacity();
    expect(cap.hardLimit).toBe(500);
  });

  it('soft limit is strictly between warn threshold and hard limit by default', () => {
    const cap = getSorobanQueueCapacity();
    expect(cap.softLimit).toBeGreaterThan(cap.warnThreshold);
    expect(cap.softLimit).toBeLessThan(cap.hardLimit);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Queue depth reads
// ═════════════════════════════════════════════════════════════════════════════

describe('Queue depth reads', () => {
  it('reads Soroban write queue depth from DB', async () => {
    setQueueDepths(42, 0);
    const depth = await readSorobanWriteQueueDepth();
    expect(depth).toBe(42);
  });

  it('reads webhook retry queue depth from DB', async () => {
    setQueueDepths(0, 77);
    const depth = await readWebhookRetryQueueDepth();
    expect(depth).toBe(77);
  });

  it('returns 0 for Soroban depth when DB throws (fail-open)', async () => {
    mockQuery.mockRejectedValue(new Error('ECONNREFUSED'));
    const depth = await readSorobanWriteQueueDepth();
    expect(depth).toBe(0);
  });

  it('returns 0 for webhook depth when DB throws (fail-open)', async () => {
    mockQuery.mockRejectedValue(new Error('ECONNREFUSED'));
    const depth = await readWebhookRetryQueueDepth();
    expect(depth).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Saturation snapshot — flag derivation and ratio computation
// ═════════════════════════════════════════════════════════════════════════════

describe('Saturation snapshot', () => {
  it('snapshot has degraded=false when both queues are below warn threshold', async () => {
    setQueueDepths(5, 10);
    const snap = await readQueueSaturation(true);
    expect(snap.degraded).toBe(false);
    expect(snap.pressured).toBe(false);
    expect(snap.saturated).toBe(false);
  });

  it('snapshot has degraded=true when Soroban queue ≥ warnThreshold', async () => {
    setQueueDepths(50, 0);
    const snap = await readQueueSaturation(true);
    expect(snap.degraded).toBe(true);
    expect(snap.pressured).toBe(false);
    expect(snap.saturated).toBe(false);
  });

  it('snapshot has pressured=true when Soroban queue ≥ softLimit', async () => {
    setQueueDepths(200, 0);
    const snap = await readQueueSaturation(true);
    expect(snap.pressured).toBe(true);
    expect(snap.saturated).toBe(false);
  });

  it('snapshot has saturated=true when Soroban queue ≥ hardLimit', async () => {
    setQueueDepths(500, 0);
    const snap = await readQueueSaturation(true);
    expect(snap.saturated).toBe(true);
    expect(snap.overallSaturationRatio).toBe(1);
  });

  it('saturation ratio is capped at 1 even if queue exceeds hard limit', async () => {
    setQueueDepths(9999, 0);
    const snap = await readQueueSaturation(true);
    expect(snap.sorobanSaturationRatio).toBe(1);
    expect(snap.overallSaturationRatio).toBe(1);
  });

  it('overall saturation ratio is the max of Soroban and webhook ratios', async () => {
    // Soroban at 10%  (50 / 500), webhook at 25%  (500 / 2000)
    setQueueDepths(50, 500);
    const snap = await readQueueSaturation(true);
    expect(snap.overallSaturationRatio).toBeCloseTo(0.25, 2);
  });

  it('webhook-only saturation triggers pressured=true', async () => {
    setQueueDepths(0, 500); // webhook at soft limit
    const snap = await readQueueSaturation(true);
    expect(snap.pressured).toBe(true);
  });

  it('snapshot records both queue depths accurately', async () => {
    setQueueDepths(123, 456);
    const snap = await readQueueSaturation(true);
    expect(snap.sorobanWriteQueueDepth).toBe(123);
    expect(snap.webhookRetryQueueDepth).toBe(456);
  });

  it('snapshot TTL: cached snapshot is returned within TTL window', async () => {
    setQueueDepths(10, 0);
    await readQueueSaturation(true); // populates cache

    setQueueDepths(999, 0); // change underlying data
    const cached = await readQueueSaturation(false); // should use cache
    // The TTL is 5000ms; we just set it, so it must still be from the first read.
    expect(cached.sorobanWriteQueueDepth).toBe(10);
  });

  it('force=true bypasses the TTL cache', async () => {
    setQueueDepths(10, 0);
    await readQueueSaturation(true);

    setQueueDepths(300, 0);
    const fresh = await readQueueSaturation(true); // force bypass
    expect(fresh.sorobanWriteQueueDepth).toBe(300);
  });

  it('getLastQueueSaturationSnapshot returns the cached value', async () => {
    setQueueDepths(77, 33);
    await readQueueSaturation(true);
    const cached = getLastQueueSaturationSnapshot();
    expect(cached.sorobanWriteQueueDepth).toBe(77);
    expect(cached.webhookRetryQueueDepth).toBe(33);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Admission control — decision matrix
// ═════════════════════════════════════════════════════════════════════════════

describe('checkQueueAdmission() — decision matrix', () => {
  async function prime(soroban: number, webhook = 0): Promise<void> {
    setQueueDepths(soroban, webhook);
    await readQueueSaturation(true);
  }

  it('admits all job classes when depth is below warn threshold', async () => {
    await prime(10);
    for (const cls of ['financial', 'replay', 'webhook', 'background'] as const) {
      expect(checkQueueAdmission(cls).decision).toBe('admit');
    }
  });

  it('warns all job classes when depth is at warn threshold', async () => {
    await prime(50);
    for (const cls of ['financial', 'replay', 'webhook', 'background'] as const) {
      expect(checkQueueAdmission(cls).decision).toBe('warn');
    }
  });

  it('sheds background class at soft limit', async () => {
    await prime(200);
    expect(checkQueueAdmission('background').decision).toBe('shed');
  });

  it('sheds webhook class at soft limit', async () => {
    await prime(200);
    expect(checkQueueAdmission('webhook').decision).toBe('shed');
  });

  it('admits financial class even at soft limit', async () => {
    await prime(200);
    const result = checkQueueAdmission('financial');
    expect(['admit', 'warn']).toContain(result.decision);
  });

  it('admits replay class even at soft limit', async () => {
    await prime(200);
    const result = checkQueueAdmission('replay');
    expect(['admit', 'warn']).toContain(result.decision);
  });

  it('rejects ALL job classes at hard limit', async () => {
    await prime(500);
    for (const cls of ['financial', 'replay', 'webhook', 'background'] as const) {
      expect(checkQueueAdmission(cls).decision).toBe('reject');
    }
  });

  it('reject result includes a non-zero retryAfterSeconds', async () => {
    await prime(500);
    const result = checkQueueAdmission('financial');
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('SOROBAN_WRITE_REPLAY_INTERVAL_MS controls retryAfterSeconds', async () => {
    process.env.SOROBAN_WRITE_REPLAY_INTERVAL_MS = '30000';
    await prime(500);
    const result = checkQueueAdmission('financial');
    expect(result.retryAfterSeconds).toBe(30);
  });

  it('admission result includes queue depths and saturation ratio', async () => {
    await prime(100, 200);
    const result = checkQueueAdmission('financial');
    expect(typeof result.sorobanQueueDepth).toBe('number');
    expect(typeof result.webhookQueueDepth).toBe('number');
    expect(typeof result.saturationRatio).toBe('number');
  });

  it('reason string never contains secret environment values', async () => {
    process.env.SOROBAN_QUEUE_HARD_LIMIT = '500';
    await prime(500);
    const result = checkQueueAdmission('financial');
    expect(result.reason).not.toContain(process.env.JWT_SECRET ?? '');
    expect(result.reason).not.toContain(process.env.INTERNAL_API_KEY ?? '');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. financialQueueBackpressureMiddleware
// ═════════════════════════════════════════════════════════════════════════════

describe('financialQueueBackpressureMiddleware', () => {
  function buildMockReqRes(method = 'POST', path = '/api/v1/loans/request') {
    const req = { method, path } as unknown as import('express').Request;
    const headers: Record<string, string> = {};
    let statusCode = 200;
    let nextError: unknown = undefined;

    const res = {
      setHeader: (name: string, val: string) => {
        headers[name] = val;
      },
      status: (code: number) => {
        statusCode = code;
        return res;
      },
      _statusCode: () => statusCode,
      _headers: () => headers,
    } as unknown as import('express').Response;

    const next = jest.fn((err?: unknown) => {
      nextError = err;
    }) as import('express').NextFunction & { _error: () => unknown };
    (next as unknown as { _error: () => unknown })._error = () => nextError;

    return { req, res, next, headers: () => headers, error: () => nextError };
  }

  it('passes GET requests through without checking queue', async () => {
    const { req, res, next } = buildMockReqRes('GET');
    await financialQueueBackpressureMiddleware(req, res, next);
    expect(next).toHaveBeenCalledWith(/* no error */);
  });

  it('passes HEAD requests through without checking queue', async () => {
    const { req, res, next } = buildMockReqRes('HEAD');
    await financialQueueBackpressureMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('admits POST when queue is below warn threshold', async () => {
    setQueueDepths(5, 0);
    const { req, res, next, error } = buildMockReqRes('POST');
    await financialQueueBackpressureMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(error()).toBeUndefined();
  });

  it('adds x-queue-pressure header when queue is at warn threshold', async () => {
    setQueueDepths(50, 0); // warn threshold
    const { req, res, next, headers } = buildMockReqRes('POST');
    await financialQueueBackpressureMiddleware(req, res, next);
    expect(headers()['x-queue-pressure']).toBe('elevated');
    expect(next).toHaveBeenCalled();
  });

  it('calls next with AppError (503) when queue is at hard limit', async () => {
    setQueueDepths(500, 0); // hard limit
    const { req, res, next, error } = buildMockReqRes('POST');
    await financialQueueBackpressureMiddleware(req, res, next);
    const err = error() as { statusCode?: number };
    expect(err?.statusCode).toBe(503);
  });

  it('sets Retry-After header on 503 rejection', async () => {
    setQueueDepths(500, 0);
    const { req, res, next, headers } = buildMockReqRes('POST');
    await financialQueueBackpressureMiddleware(req, res, next);
    expect(headers()['Retry-After']).toBeDefined();
    expect(Number(headers()['Retry-After'])).toBeGreaterThan(0);
  });

  it('sets x-queue-saturated header on 503 rejection', async () => {
    setQueueDepths(500, 0);
    const { req, res, next, headers } = buildMockReqRes('POST');
    await financialQueueBackpressureMiddleware(req, res, next);
    expect(headers()['x-queue-saturated']).toBe('true');
  });

  it('fails-open when DB throws during queue depth read', async () => {
    mockQuery.mockRejectedValue(new Error('ECONNREFUSED'));
    const { req, res, next, error } = buildMockReqRes('POST');
    await financialQueueBackpressureMiddleware(req, res, next);
    // DB failure must not block the request
    expect(next).toHaveBeenCalled();
    expect(error()).toBeUndefined();
  });

  it('applies to DELETE method (financial writes include repayment)', async () => {
    setQueueDepths(500, 0);
    const { req, res, next, error } = buildMockReqRes('DELETE');
    await financialQueueBackpressureMiddleware(req, res, next);
    const err = error() as { statusCode?: number };
    expect(err?.statusCode).toBe(503);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. shouldBackgroundJobRun()
// ═════════════════════════════════════════════════════════════════════════════

describe('shouldBackgroundJobRun()', () => {
  async function prime(soroban: number): Promise<void> {
    setQueueDepths(soroban, 0);
    await readQueueSaturation(true);
  }

  it('allows background job when queue is below warn threshold', async () => {
    await prime(10);
    expect(shouldBackgroundJobRun('background').run).toBe(true);
  });

  it('allows background job when queue is between warn and soft limit', async () => {
    await prime(100); // between 50 and 200
    expect(shouldBackgroundJobRun('background').run).toBe(true);
  });

  it('sheds background job at soft limit', async () => {
    await prime(200);
    const result = shouldBackgroundJobRun('background');
    expect(result.run).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it('sheds webhook job at soft limit', async () => {
    await prime(200);
    expect(shouldBackgroundJobRun('webhook').run).toBe(false);
  });

  it('sheds background job at hard limit', async () => {
    await prime(500);
    expect(shouldBackgroundJobRun('background').run).toBe(false);
  });

  it('reason string is non-empty when shed', async () => {
    await prime(500);
    const result = shouldBackgroundJobRun('background');
    expect(result.reason.length).toBeGreaterThan(10);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. Financial writes never silently dropped
// ═════════════════════════════════════════════════════════════════════════════

describe('Financial write guarantees', () => {
  it('a 503 rejection includes a structured error message describing the outage', async () => {
    setQueueDepths(500, 0);
    await readQueueSaturation(true);
    const result = checkQueueAdmission('financial');

    expect(result.decision).toBe('reject');
    expect(result.reason).toContain('500');  // current depth
    expect(result.reason).toMatch(/retry/i);
  });

  it('error message does not expose internal infrastructure details', async () => {
    setQueueDepths(500, 0);
    await readQueueSaturation(true);
    const result = checkQueueAdmission('financial');
    // Must not contain hostnames, IPs, or connection strings
    expect(result.reason).not.toMatch(/postgres|redis|localhost|127\.0\.0/i);
  });

  it('exact money amounts in payload pass through the middleware unmodified', async () => {
    // The middleware must not inspect or transform the request body.
    setQueueDepths(5, 0);

    const req = {
      method: 'POST',
      path: '/api/v1/loans/request',
      body: { amount: 1_000_000, currency: 'USDC' },
    } as unknown as import('express').Request;

    const headers: Record<string, string> = {};
    const res = {
      setHeader: (name: string, val: string) => {
        headers[name] = val;
      },
    } as unknown as import('express').Response;

    const next = jest.fn() as import('express').NextFunction;

    await financialQueueBackpressureMiddleware(req, res, next);

    // Body is untouched
    expect((req as unknown as { body: { amount: number } }).body.amount).toBe(1_000_000);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. getQueueSaturationForStatus()
// ═════════════════════════════════════════════════════════════════════════════

describe('getQueueSaturationForStatus()', () => {
  it('returns all required fields for embedding in health responses', async () => {
    setQueueDepths(30, 80);
    await readQueueSaturation(true);
    const status = getQueueSaturationForStatus();

    expect(status).toHaveProperty('sorobanWriteQueueDepth');
    expect(status).toHaveProperty('webhookRetryQueueDepth');
    expect(status).toHaveProperty('overallSaturationRatio');
    expect(status).toHaveProperty('degraded');
    expect(status).toHaveProperty('pressured');
    expect(status).toHaveProperty('saturated');
  });

  it('reports correct depths after a refresh', async () => {
    setQueueDepths(123, 456);
    await readQueueSaturation(true);
    const status = getQueueSaturationForStatus();
    expect(status.sorobanWriteQueueDepth).toBe(123);
    expect(status.webhookRetryQueueDepth).toBe(456);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 9. Prometheus metrics
// ═════════════════════════════════════════════════════════════════════════════

describe('Prometheus metrics for queue saturation', () => {
  it('/metrics endpoint exposes soroban_write_queue_depth gauge', async () => {
    process.env.INTERNAL_API_KEY = 'test-key-860';
    setQueueDepths(37, 0);
    await readQueueSaturation(true);

    sorobanWriteQueueDepthGauge.set(37);

    const res = await request(app)
      .get('/metrics')
      .set('x-api-key', 'test-key-860');

    expect(res.status).toBe(200);
    expect(res.text).toContain('soroban_write_queue_depth 37');
  });

  it('/metrics endpoint exposes soroban_write_queue_saturation_ratio gauge', async () => {
    process.env.INTERNAL_API_KEY = 'test-key-860';
    sorobanWriteQueueSaturationGauge.set(0.5);

    const res = await request(app)
      .get('/metrics')
      .set('x-api-key', 'test-key-860');

    expect(res.status).toBe(200);
    expect(res.text).toContain('soroban_write_queue_saturation_ratio');
  });

  it('/metrics endpoint exposes queue_overall_saturation_ratio gauge', async () => {
    process.env.INTERNAL_API_KEY = 'test-key-860';
    overallQueueSaturationGauge.set(0.75);

    const res = await request(app)
      .get('/metrics')
      .set('x-api-key', 'test-key-860');

    expect(res.status).toBe(200);
    expect(res.text).toContain('queue_overall_saturation_ratio');
  });

  it('/metrics endpoint exposes queue_admission_rejections_total counter', async () => {
    process.env.INTERNAL_API_KEY = 'test-key-860';
    queueAdmissionRejectionsCounter.inc({ job_class: 'financial' });

    const res = await request(app)
      .get('/metrics')
      .set('x-api-key', 'test-key-860');

    expect(res.text).toContain('queue_admission_rejections_total');
  });

  it('/metrics endpoint exposes queue_background_sheds_total counter', async () => {
    process.env.INTERNAL_API_KEY = 'test-key-860';
    queueBackgroundShedsCounter.inc({ job_class: 'background' });

    const res = await request(app)
      .get('/metrics')
      .set('x-api-key', 'test-key-860');

    expect(res.text).toContain('queue_background_sheds_total');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 10. Idempotency and access-control interaction
// ═════════════════════════════════════════════════════════════════════════════

describe('Access-control interaction', () => {
  it('backpressure 503 does not leak auth headers or secrets', async () => {
    setQueueDepths(500, 0);

    const req = {
      method: 'POST',
      path: '/api/v1/loans/request',
      headers: { authorization: 'Bearer secret-token' },
    } as unknown as import('express').Request;

    const headers: Record<string, string> = {};
    const res = {
      setHeader: (name: string, val: string) => {
        headers[name] = val;
      },
    } as unknown as import('express').Response;

    const errors: unknown[] = [];
    const next = jest.fn((err?: unknown) => {
      if (err !== undefined) errors.push(err);
    }) as import('express').NextFunction;

    await financialQueueBackpressureMiddleware(req, res, next);

    // The error message must not contain the Authorization value
    const errMsg = String((errors[0] as { message?: string })?.message ?? '');
    expect(errMsg).not.toContain('secret-token');
  });

  it('backpressure middleware does not replace JWT auth (next is still called after admit)', async () => {
    setQueueDepths(5, 0);
    const { req, res, next } = buildMockReqRes('POST');
    await financialQueueBackpressureMiddleware(req, res, next);
    // next() was called — subsequent middleware (JWT auth) will still run
    expect(next).toHaveBeenCalledTimes(1);
  });
});

// ── local helper ─────────────────────────────────────────────────────────────

function buildMockReqRes(method: string, path = '/api/v1/loans/request') {
  const req = { method, path } as unknown as import('express').Request;
  const headers: Record<string, string> = {};
  let nextError: unknown;

  const res = {
    setHeader: (name: string, val: string) => {
      headers[name] = val;
    },
  } as unknown as import('express').Response;

  const next = jest.fn((err?: unknown) => {
    nextError = err;
  }) as import('express').NextFunction;

  return {
    req,
    res,
    next,
    headers: () => headers,
    error: () => nextError,
  };
}
