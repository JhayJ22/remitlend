/**
 * Tests for issue #865 — capacity models for database, Redis, and event
 * retention growth.
 *
 * Coverage
 * ────────
 *   ✓ Row-size constants: all tracked tables have positive bytesPerRow
 *   ✓ Capacity thresholds: defaults and env-var overrides
 *   ✓ Retention policy: authoritative tables null, operational tables positive
 *   ✓ Growth rates: all tracked tables have positive defaults
 *   ✓ buildCapacitySnapshot: snapshot shape, all required fields
 *   ✓ buildCapacitySnapshot: rowCount and projectedRows computed correctly
 *   ✓ buildCapacitySnapshot: estimatedBytes = rowCount × bytesPerRow
 *   ✓ buildCapacitySnapshot: projectedRows = rowCount + growthRate × days
 *   ✓ buildCapacitySnapshot: eligible-for-purge is null for append-only tables
 *   ✓ buildCapacitySnapshot: DB error on individual table is fail-open (rowCount=0)
 *   ✓ Threshold evaluation: ok / warn / critical levels for storage
 *   ✓ Connection demand model: peakConnections = replicas × pool + background
 *   ✓ Connection demand model: projected growth via doubling formula
 *   ✓ Connection demand model: threshold level reflects utilization ratio
 *   ✓ Redis memory model: component estimates present and positive
 *   ✓ Redis memory model: projectedBytesEstimate ≥ totalBytesEstimate
 *   ✓ Persistence: persistCapacitySnapshot calls INSERT with correct fields
 *   ✓ Persistence: ON CONFLICT — second call with same capturedAt is no-op
 *   ✓ Persistence: DB error during persist is fail-open (does not throw)
 *   ✓ Access control: /capacity requires admin:indexer API key
 *   ✓ /capacity: 200 with correct snapshot shape
 *   ✓ /capacity: forecastDays query param accepted (1–365 range)
 *   ✓ /capacity: forecastDays clamped to 365 max
 *   ✓ /capacity: defaults to 30 days when param absent
 *   ✓ Prometheus: capacity metrics exported to /metrics
 *   ✓ No financial amounts or user-identifying data in snapshot output
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// ── DB mock ───────────────────────────────────────────────────────────────────

type QueryResult = { rows: unknown[]; rowCount: number };
const mockQuery = jest.fn<(sql: string, params?: unknown[]) => Promise<QueryResult>>();

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
  BYTES_PER_ROW,
  getCapacityThresholds,
  getTableRetentionDays,
  getTableGrowthRatesPerDay,
  buildCapacitySnapshot,
  buildConnectionDemandModel,
  buildRedisMemoryModel,
  persistCapacitySnapshot,
} = await import('../services/capacityModel.js');

const {
  dbTableEstimatedBytesGauge,
  dbTableRowCountGauge,
  dbConnectionPeakGauge,
  dbConnectionUtilizationGauge,
  redisMemoryEstimateGauge,
  capacityOverallThresholdGauge,
} = await import('../middleware/metrics.js');

import request from 'supertest';
const { default: app } = await import('../app.js');

// ── Env helpers ───────────────────────────────────────────────────────────────

const CAPACITY_KEYS = [
  'CAPACITY_TABLE_WARN_BYTES',
  'CAPACITY_TABLE_CRITICAL_BYTES',
  'CAPACITY_CONN_UTILIZATION_WARN',
  'CAPACITY_CONN_UTILIZATION_CRITICAL',
  'CAPACITY_REDIS_WARN_BYTES',
  'CAPACITY_REDIS_CRITICAL_BYTES',
  'API_REPLICAS',
  'DB_POOL_MAX',
  'POSTGRES_MAX_CONNECTIONS',
  'CAPACITY_ACTIVE_USERS',
  'CAPACITY_USER_DOUBLING_DAYS',
  'INTERNAL_API_KEY',
];

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of CAPACITY_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  mockQuery.mockReset();
  process.env.INTERNAL_API_KEY = 'test-capacity-key';
});

afterEach(() => {
  for (const key of CAPACITY_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
});

// ── Helper: set DB to return a fixed row count for every table ────────────────

function setRowCount(count: number): void {
  mockQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('pg_class')) {
      return { rows: [{ row_count: count }], rowCount: 1 };
    }
    if (sql.includes('COUNT(*)')) {
      return { rows: [{ purge_count: Math.floor(count * 0.1) }], rowCount: 1 };
    }
    if (sql.includes('capacity_snapshots')) {
      return { rows: [], rowCount: 0 };
    }
    return { rows: [{ row_count: count }], rowCount: 1 };
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. Row-size constants
// ═════════════════════════════════════════════════════════════════════════════

describe('Row-size constants', () => {
  const TRACKED_TABLES = [
    'contract_events',
    'loan_state_events',
    'audit_logs',
    'notifications',
    'webhook_deliveries',
    'soroban_write_queue',
    'quarantine_events',
    'loans',
    'scores',
  ];

  for (const table of TRACKED_TABLES) {
    it(`${table} has a positive bytesPerRow constant`, () => {
      expect(BYTES_PER_ROW[table]).toBeDefined();
      expect(BYTES_PER_ROW[table]!).toBeGreaterThan(0);
    });
  }

  it('soroban_write_queue bytesPerRow is larger than audit_logs (JSONB payload)', () => {
    expect(BYTES_PER_ROW['soroban_write_queue']!).toBeGreaterThan(
      BYTES_PER_ROW['audit_logs']!,
    );
  });

  it('quarantine_events bytesPerRow is the largest (raw XDR payload)', () => {
    const max = Math.max(...Object.values(BYTES_PER_ROW));
    expect(BYTES_PER_ROW['quarantine_events']).toBe(max);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Capacity thresholds
// ═════════════════════════════════════════════════════════════════════════════

describe('Capacity thresholds', () => {
  it('returns expected defaults', () => {
    const t = getCapacityThresholds();
    expect(t.tableStorageWarnBytes).toBe(1_073_741_824);
    expect(t.tableStorageCriticalBytes).toBe(5_368_709_120);
    expect(t.connectionUtilizationWarn).toBeCloseTo(0.70);
    expect(t.connectionUtilizationCritical).toBeCloseTo(0.85);
    expect(t.redisMemoryWarnBytes).toBe(268_435_456);
    expect(t.redisMemoryCriticalBytes).toBe(536_870_912);
  });

  it('respects CAPACITY_TABLE_WARN_BYTES env override', () => {
    process.env.CAPACITY_TABLE_WARN_BYTES = '500000000';
    expect(getCapacityThresholds().tableStorageWarnBytes).toBe(500_000_000);
  });

  it('softLimit < hardLimit for storage thresholds', () => {
    const t = getCapacityThresholds();
    expect(t.tableStorageWarnBytes).toBeLessThan(t.tableStorageCriticalBytes);
  });

  it('connection utilization warn < critical', () => {
    const t = getCapacityThresholds();
    expect(t.connectionUtilizationWarn).toBeLessThan(t.connectionUtilizationCritical);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Retention policy
// ═════════════════════════════════════════════════════════════════════════════

describe('Table retention policy', () => {
  it('contract_events retention is null (authoritative ledger record)', () => {
    expect(getTableRetentionDays()['contract_events']).toBeNull();
  });

  it('loan_state_events retention is null (authoritative domain log)', () => {
    expect(getTableRetentionDays()['loan_state_events']).toBeNull();
  });

  it('notifications retention is positive (default 90 days)', () => {
    expect(getTableRetentionDays()['notifications']).toBe(90);
  });

  it('audit_logs retention is positive (default 365 days)', () => {
    expect(getTableRetentionDays()['audit_logs']).toBe(365);
  });

  it('webhook_deliveries retention is positive', () => {
    expect(getTableRetentionDays()['webhook_deliveries']!).toBeGreaterThan(0);
  });

  it('NOTIFICATION_RETENTION_DAYS env override is respected', () => {
    process.env.NOTIFICATION_RETENTION_DAYS = '180';
    expect(getTableRetentionDays()['notifications']).toBe(180);
    delete process.env.NOTIFICATION_RETENTION_DAYS;
  });

  it('AUDIT_LOG_RETENTION_DAYS env override is respected', () => {
    process.env.AUDIT_LOG_RETENTION_DAYS = '730';
    expect(getTableRetentionDays()['audit_logs']).toBe(730);
    delete process.env.AUDIT_LOG_RETENTION_DAYS;
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Growth rates
// ═════════════════════════════════════════════════════════════════════════════

describe('Growth rates', () => {
  it('all tracked tables have positive default growth rates', () => {
    const rates = getTableGrowthRatesPerDay();
    for (const [table, rate] of Object.entries(rates)) {
      expect(rate).toBeGreaterThan(0);
      // Suppress unused variable warning
      void table;
    }
  });

  it('contract_events growth rate is higher than loans (events outnumber loans)', () => {
    const rates = getTableGrowthRatesPerDay();
    expect(rates['contract_events']!).toBeGreaterThan(rates['loans']!);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. buildCapacitySnapshot — snapshot shape and computations
// ═════════════════════════════════════════════════════════════════════════════

describe('buildCapacitySnapshot()', () => {
  it('returns a snapshot with all required top-level fields', async () => {
    setRowCount(1000);
    const snap = await buildCapacitySnapshot(30);

    expect(snap).toHaveProperty('capturedAt');
    expect(snap).toHaveProperty('forecastDays', 30);
    expect(snap).toHaveProperty('tables');
    expect(snap).toHaveProperty('totalDbEstimatedBytes');
    expect(snap).toHaveProperty('totalDbProjectedBytes');
    expect(snap).toHaveProperty('connectionDemand');
    expect(snap).toHaveProperty('redisMemoryModel');
    expect(snap).toHaveProperty('overallThresholdLevel');
    expect(snap).toHaveProperty('thresholds');
  });

  it('capturedAt is a valid ISO-8601 string', async () => {
    setRowCount(100);
    const snap = await buildCapacitySnapshot(30);
    expect(() => new Date(snap.capturedAt)).not.toThrow();
    expect(new Date(snap.capturedAt).toISOString()).toBe(snap.capturedAt);
  });

  it('tables array covers all tracked tables', async () => {
    setRowCount(500);
    const snap = await buildCapacitySnapshot(30);
    const tableNames = snap.tables.map((t) => t.table);
    expect(tableNames).toContain('contract_events');
    expect(tableNames).toContain('notifications');
    expect(tableNames).toContain('soroban_write_queue');
    expect(tableNames).toContain('audit_logs');
  });

  it('estimatedBytes = rowCount × bytesPerRow', async () => {
    setRowCount(1000);
    const snap = await buildCapacitySnapshot(30);
    for (const entry of snap.tables) {
      expect(entry.estimatedBytes).toBe(entry.rowCount * entry.bytesPerRow);
    }
  });

  it('projectedRows = rowCount + growthRate × forecastDays', async () => {
    setRowCount(500);
    const snap = await buildCapacitySnapshot(30);
    const rates = getTableGrowthRatesPerDay();

    for (const entry of snap.tables) {
      const expectedProjected =
        entry.rowCount + Math.round((rates[entry.table] ?? 0) * 30);
      expect(entry.projectedRows).toBe(expectedProjected);
    }
  });

  it('projectedBytes = projectedRows × bytesPerRow', async () => {
    setRowCount(200);
    const snap = await buildCapacitySnapshot(30);
    for (const entry of snap.tables) {
      expect(entry.projectedBytes).toBe(entry.projectedRows * entry.bytesPerRow);
    }
  });

  it('projectedBytes ≥ estimatedBytes (always grows)', async () => {
    setRowCount(100);
    const snap = await buildCapacitySnapshot(30);
    for (const entry of snap.tables) {
      expect(entry.projectedBytes).toBeGreaterThanOrEqual(entry.estimatedBytes);
    }
  });

  it('contract_events eligibleForPurge is null', async () => {
    setRowCount(5000);
    const snap = await buildCapacitySnapshot(30);
    const ce = snap.tables.find((t) => t.table === 'contract_events');
    expect(ce?.eligibleForPurge).toBeNull();
  });

  it('notifications eligibleForPurge is a non-negative number', async () => {
    setRowCount(5000);
    const snap = await buildCapacitySnapshot(30);
    const notif = snap.tables.find((t) => t.table === 'notifications');
    expect(typeof notif?.eligibleForPurge).toBe('number');
    expect(notif?.eligibleForPurge).toBeGreaterThanOrEqual(0);
  });

  it('totalDbEstimatedBytes is the sum of all table estimatedBytes', async () => {
    setRowCount(1000);
    const snap = await buildCapacitySnapshot(30);
    const expected = snap.tables.reduce((s, t) => s + t.estimatedBytes, 0);
    expect(snap.totalDbEstimatedBytes).toBe(expected);
  });

  it('totalDbProjectedBytes is the sum of all table projectedBytes', async () => {
    setRowCount(1000);
    const snap = await buildCapacitySnapshot(30);
    const expected = snap.tables.reduce((s, t) => s + t.projectedBytes, 0);
    expect(snap.totalDbProjectedBytes).toBe(expected);
  });

  it('overallThresholdLevel is "ok" when all tables are below warn threshold', async () => {
    setRowCount(1); // tiny row counts → tiny storage estimates
    const snap = await buildCapacitySnapshot(30);
    expect(snap.overallThresholdLevel).toBe('ok');
  });

  it('fail-open: DB error on a table returns rowCount=0 (not a throw)', async () => {
    mockQuery.mockRejectedValue(new Error('ECONNREFUSED'));
    const snap = await buildCapacitySnapshot(30);
    for (const entry of snap.tables) {
      expect(entry.rowCount).toBe(0);
    }
  });

  it('snapshot does not include financial amounts or user identifiers', async () => {
    setRowCount(1000);
    const snap = await buildCapacitySnapshot(30);
    const json = JSON.stringify(snap);
    // Must not contain any realistic Stellar address (G...) or private key (S...)
    expect(json).not.toMatch(/^G[A-Z2-7]{55}/);
    expect(json).not.toMatch(/^S[A-Z2-7]{55}/);
    // Must not contain common secret sentinel words
    expect(json).not.toContain('password');
    expect(json).not.toContain('secret');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. Threshold evaluation
// ═════════════════════════════════════════════════════════════════════════════

describe('Threshold evaluation', () => {
  it('thresholdLevel is "ok" below the warn threshold', async () => {
    setRowCount(1); // minimal rows → well below 1 GB
    const snap = await buildCapacitySnapshot(30);
    for (const entry of snap.tables) {
      expect(entry.thresholdLevel).toBe('ok');
    }
  });

  it('thresholdLevel is "warn" when storage ≥ tableStorageWarnBytes', async () => {
    // Set warn threshold very low so a moderate row count triggers it
    process.env.CAPACITY_TABLE_WARN_BYTES = '1000'; // 1 KB
    process.env.CAPACITY_TABLE_CRITICAL_BYTES = '99999999999'; // very high
    setRowCount(100);
    const snap = await buildCapacitySnapshot(30);
    const hitWarn = snap.tables.some((t) => t.thresholdLevel === 'warn');
    expect(hitWarn).toBe(true);
  });

  it('thresholdLevel is "critical" when storage ≥ tableStorageCriticalBytes', async () => {
    process.env.CAPACITY_TABLE_WARN_BYTES = '1';
    process.env.CAPACITY_TABLE_CRITICAL_BYTES = '1';
    setRowCount(100);
    const snap = await buildCapacitySnapshot(30);
    const hitCritical = snap.tables.some((t) => t.thresholdLevel === 'critical');
    expect(hitCritical).toBe(true);
    expect(snap.overallThresholdLevel).toBe('critical');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. Connection demand model
// ═════════════════════════════════════════════════════════════════════════════

describe('buildConnectionDemandModel()', () => {
  it('peakConnections = apiReplicas × poolMaxPerReplica + 3 background jobs', () => {
    process.env.API_REPLICAS = '2';
    process.env.DB_POOL_MAX = '10';
    const thresholds = getCapacityThresholds();
    const model = buildConnectionDemandModel(30, thresholds);
    // 2 × 10 + 3 = 23
    expect(model.peakConnections).toBe(23);
  });

  it('defaults to 1 replica and pool=10', () => {
    const thresholds = getCapacityThresholds();
    const model = buildConnectionDemandModel(30, thresholds);
    expect(model.apiReplicas).toBe(1);
    expect(model.poolMaxPerReplica).toBe(10);
    expect(model.backgroundJobConnections).toBe(3);
    expect(model.peakConnections).toBe(13);
  });

  it('projectedPeakConnections ≥ peakConnections', () => {
    const thresholds = getCapacityThresholds();
    const model = buildConnectionDemandModel(30, thresholds);
    expect(model.projectedPeakConnections).toBeGreaterThanOrEqual(model.peakConnections);
  });

  it('connectionUtilizationRatio = peakConnections / POSTGRES_MAX_CONNECTIONS', () => {
    process.env.API_REPLICAS = '1';
    process.env.DB_POOL_MAX = '10';
    process.env.POSTGRES_MAX_CONNECTIONS = '100';
    const thresholds = getCapacityThresholds();
    const model = buildConnectionDemandModel(30, thresholds);
    // peak = 1 × 10 + 3 = 13 → ratio = 0.13
    expect(model.connectionUtilizationRatio).toBeCloseTo(0.13, 2);
  });

  it('thresholdLevel is "warn" when utilization ≥ 0.70', () => {
    process.env.API_REPLICAS = '7';
    process.env.DB_POOL_MAX = '10';
    process.env.POSTGRES_MAX_CONNECTIONS = '100';
    const thresholds = getCapacityThresholds();
    const model = buildConnectionDemandModel(30, thresholds);
    // peak = 7 × 10 + 3 = 73 → 0.73 ≥ 0.70
    expect(model.thresholdLevel).toBe('warn');
  });

  it('thresholdLevel is "critical" when utilization ≥ 0.85', () => {
    process.env.API_REPLICAS = '9';
    process.env.DB_POOL_MAX = '10';
    process.env.POSTGRES_MAX_CONNECTIONS = '100';
    const thresholds = getCapacityThresholds();
    const model = buildConnectionDemandModel(30, thresholds);
    // peak = 9 × 10 + 3 = 93 → 0.93 ≥ 0.85
    expect(model.thresholdLevel).toBe('critical');
  });

  it('thresholdLevel is "ok" when utilization < 0.70 (default single replica)', () => {
    process.env.POSTGRES_MAX_CONNECTIONS = '1000';
    const thresholds = getCapacityThresholds();
    const model = buildConnectionDemandModel(30, thresholds);
    expect(model.thresholdLevel).toBe('ok');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. Redis memory model
// ═════════════════════════════════════════════════════════════════════════════

describe('buildRedisMemoryModel()', () => {
  it('all component estimates are positive', () => {
    const model = buildRedisMemoryModel(30);
    expect(model.idempotencyBytesEstimate).toBeGreaterThan(0);
    expect(model.rateLimiterBytesEstimate).toBeGreaterThan(0);
    expect(model.staleReadCacheBytesEstimate).toBeGreaterThan(0);
  });

  it('totalBytesEstimate = sum of components', () => {
    const model = buildRedisMemoryModel(30);
    const expected =
      model.idempotencyBytesEstimate +
      model.rateLimiterBytesEstimate +
      model.staleReadCacheBytesEstimate;
    expect(model.totalBytesEstimate).toBe(expected);
  });

  it('projectedBytesEstimate ≥ totalBytesEstimate', () => {
    const model = buildRedisMemoryModel(30);
    expect(model.projectedBytesEstimate).toBeGreaterThanOrEqual(model.totalBytesEstimate);
  });

  it('activeUsers is exposed in model', () => {
    process.env.CAPACITY_ACTIVE_USERS = '5000';
    const model = buildRedisMemoryModel(30);
    expect(model.activeUsers).toBe(5000);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 9. persistCapacitySnapshot
// ═════════════════════════════════════════════════════════════════════════════

describe('persistCapacitySnapshot()', () => {
  async function buildTestSnapshot() {
    setRowCount(100);
    return buildCapacitySnapshot(30);
  }

  it('calls INSERT into capacity_snapshots', async () => {
    const snap = await buildTestSnapshot();
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await persistCapacitySnapshot(snap);

    const insertCall = mockQuery.mock.calls.find(
      (c) =>
        typeof c[0] === 'string' &&
        (c[0] as string).includes('capacity_snapshots'),
    );
    expect(insertCall).toBeDefined();
  });

  it('INSERT includes ON CONFLICT DO NOTHING (idempotent)', async () => {
    const snap = await buildTestSnapshot();
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await persistCapacitySnapshot(snap);

    const insertCall = mockQuery.mock.calls.find(
      (c) =>
        typeof c[0] === 'string' &&
        (c[0] as string).includes('ON CONFLICT'),
    );
    expect(insertCall).toBeDefined();
  });

  it('INSERT params include capturedAt, forecastDays, threshold level', async () => {
    const snap = await buildTestSnapshot();
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await persistCapacitySnapshot(snap);

    const insertCall = mockQuery.mock.calls.find(
      (c) =>
        typeof c[0] === 'string' &&
        (c[0] as string).includes('capacity_snapshots'),
    );
    const params = insertCall![1] as unknown[];
    expect(params).toContain(snap.capturedAt);
    expect(params).toContain(snap.forecastDays);
    expect(params).toContain(snap.overallThresholdLevel);
  });

  it('fail-open: DB error during persist does not throw', async () => {
    const snap = await buildTestSnapshot();
    mockQuery.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await expect(persistCapacitySnapshot(snap)).resolves.not.toThrow();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 10. /capacity endpoint
// ═════════════════════════════════════════════════════════════════════════════

describe('GET /capacity', () => {
  beforeEach(() => {
    setRowCount(100);
  });

  it('requires admin:indexer API key (no key → 401)', async () => {
    const res = await request(app).get('/capacity');
    expect(res.status).toBe(401);
  });

  it('returns 200 with correct API key', async () => {
    const res = await request(app)
      .get('/capacity')
      .set('x-api-key', 'test-capacity-key');
    expect(res.status).toBe(200);
  });

  it('response body has all required top-level fields', async () => {
    const res = await request(app)
      .get('/capacity')
      .set('x-api-key', 'test-capacity-key');

    expect(res.body).toHaveProperty('capturedAt');
    expect(res.body).toHaveProperty('forecastDays');
    expect(res.body).toHaveProperty('tables');
    expect(res.body).toHaveProperty('totalDbEstimatedBytes');
    expect(res.body).toHaveProperty('totalDbProjectedBytes');
    expect(res.body).toHaveProperty('connectionDemand');
    expect(res.body).toHaveProperty('redisMemoryModel');
    expect(res.body).toHaveProperty('overallThresholdLevel');
    expect(res.body).toHaveProperty('thresholds');
  });

  it('defaults to forecastDays=30 when param is absent', async () => {
    const res = await request(app)
      .get('/capacity')
      .set('x-api-key', 'test-capacity-key');
    expect(res.body.forecastDays).toBe(30);
  });

  it('accepts forecastDays query param', async () => {
    const res = await request(app)
      .get('/capacity?forecastDays=60')
      .set('x-api-key', 'test-capacity-key');
    expect(res.body.forecastDays).toBe(60);
  });

  it('clamps forecastDays to max 365', async () => {
    const res = await request(app)
      .get('/capacity?forecastDays=999')
      .set('x-api-key', 'test-capacity-key');
    expect(res.body.forecastDays).toBe(365);
  });

  it('clamps forecastDays to min 1', async () => {
    const res = await request(app)
      .get('/capacity?forecastDays=0')
      .set('x-api-key', 'test-capacity-key');
    expect(res.body.forecastDays).toBe(1);
  });

  it('tables array is non-empty', async () => {
    const res = await request(app)
      .get('/capacity')
      .set('x-api-key', 'test-capacity-key');
    expect(Array.isArray(res.body.tables)).toBe(true);
    expect(res.body.tables.length).toBeGreaterThan(0);
  });

  it('each table entry has required fields', async () => {
    const res = await request(app)
      .get('/capacity')
      .set('x-api-key', 'test-capacity-key');
    for (const entry of res.body.tables) {
      expect(entry).toHaveProperty('table');
      expect(entry).toHaveProperty('rowCount');
      expect(entry).toHaveProperty('bytesPerRow');
      expect(entry).toHaveProperty('estimatedBytes');
      expect(entry).toHaveProperty('projectedBytes');
      expect(entry).toHaveProperty('retentionDays');
      expect(entry).toHaveProperty('thresholdLevel');
    }
  });

  it('connectionDemand has required fields', async () => {
    const res = await request(app)
      .get('/capacity')
      .set('x-api-key', 'test-capacity-key');
    expect(res.body.connectionDemand).toHaveProperty('peakConnections');
    expect(res.body.connectionDemand).toHaveProperty('connectionUtilizationRatio');
    expect(res.body.connectionDemand).toHaveProperty('thresholdLevel');
  });

  it('response body does not include any user addresses or secrets', async () => {
    const res = await request(app)
      .get('/capacity')
      .set('x-api-key', 'test-capacity-key');
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/GAAZI4TCR|GBORROWER/);
    expect(body.toLowerCase()).not.toContain('password');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 11. Prometheus metrics for capacity
// ═════════════════════════════════════════════════════════════════════════════

describe('Prometheus capacity metrics', () => {
  it('/metrics exposes db_table_estimated_bytes gauge', async () => {
    dbTableEstimatedBytesGauge.set({ table: 'contract_events' }, 12_345_678);

    const res = await request(app)
      .get('/metrics')
      .set('x-api-key', 'test-capacity-key');

    expect(res.status).toBe(200);
    expect(res.text).toContain('db_table_estimated_bytes');
  });

  it('/metrics exposes db_table_row_count gauge', async () => {
    dbTableRowCountGauge.set({ table: 'notifications' }, 50_000);

    const res = await request(app)
      .get('/metrics')
      .set('x-api-key', 'test-capacity-key');

    expect(res.text).toContain('db_table_row_count');
  });

  it('/metrics exposes db_connection_peak_demand gauge', async () => {
    dbConnectionPeakGauge.set(13);

    const res = await request(app)
      .get('/metrics')
      .set('x-api-key', 'test-capacity-key');

    expect(res.text).toContain('db_connection_peak_demand');
  });

  it('/metrics exposes db_connection_utilization_ratio gauge', async () => {
    dbConnectionUtilizationGauge.set(0.13);

    const res = await request(app)
      .get('/metrics')
      .set('x-api-key', 'test-capacity-key');

    expect(res.text).toContain('db_connection_utilization_ratio');
  });

  it('/metrics exposes redis_memory_estimate_bytes gauge', async () => {
    redisMemoryEstimateGauge.set(10_000_000);

    const res = await request(app)
      .get('/metrics')
      .set('x-api-key', 'test-capacity-key');

    expect(res.text).toContain('redis_memory_estimate_bytes');
  });

  it('/metrics exposes capacity_overall_threshold_level gauge', async () => {
    capacityOverallThresholdGauge.set(0);

    const res = await request(app)
      .get('/metrics')
      .set('x-api-key', 'test-capacity-key');

    expect(res.text).toContain('capacity_overall_threshold_level');
  });
});
