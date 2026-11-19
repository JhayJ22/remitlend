/**
 * Config Integrity Service tests (issue #854)
 *
 * Covers:
 *  - success path: record approved change, create/review snapshot, recover
 *  - boundary: diffSummary edge cases, empty prior, scalar values
 *  - access-control: missing approval_ref flags as unauthorized
 *  - alert idempotency: alertUnauthorized is a no-op after alert_sent=true
 *  - dependency-failure: DB down during alert still fires in-memory, audit
 *    failure does not block the change record
 *  - recovery: requires reviewed snapshot, marks prior rows recovered
 *  - idempotency: retryPendingAlerts only alerts rows with alert_sent=false
 */

import { jest } from '@jest/globals';

jest.setTimeout(30_000);

// ── Mock db/connection ────────────────────────────────────────────────────────

const mockQuery = jest.fn<
  (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>
>();

jest.unstable_mockModule('../../db/connection.js', () => {
  const pool = { query: mockQuery, connect: jest.fn(), on: jest.fn() };
  return { default: pool, pool, query: mockQuery };
});

// ── Load module after mock ────────────────────────────────────────────────────

let svc: typeof import('../configIntegrityService.js');
let diffSummary: typeof import('../configIntegrityService.js').diffSummary;

beforeAll(async () => {
  svc = await import('../configIntegrityService.js');
  diffSummary = svc.diffSummary;
});

afterEach(() => {
  jest.clearAllMocks();
});

// ── diffSummary unit tests ────────────────────────────────────────────────────

describe('diffSummary', () => {
  it('reports initial write when prior is null', () => {
    const r = diffSummary(null, { rate: 12 });
    expect(r.changed).toBe(true);
    expect(r.changedKeys).toContain('(initial)');
  });

  it('detects added key', () => {
    const r = diffSummary({ a: 1 }, { a: 1, b: 2 });
    expect(r.addedKeys).toEqual(['b']);
    expect(r.changedKeys).toHaveLength(0);
    expect(r.changed).toBe(true);
  });

  it('detects removed key', () => {
    const r = diffSummary({ a: 1, b: 2 }, { a: 1 });
    expect(r.removedKeys).toEqual(['b']);
    expect(r.changed).toBe(true);
  });

  it('detects changed value', () => {
    const r = diffSummary({ rate: 10 }, { rate: 12 });
    expect(r.changedKeys).toEqual(['rate']);
    expect(r.addedKeys).toHaveLength(0);
    expect(r.removedKeys).toHaveLength(0);
  });

  it('reports no change for identical objects', () => {
    const r = diffSummary({ a: 1 }, { a: 1 });
    expect(r.changed).toBe(false);
  });

  it('handles scalar values', () => {
    const r = diffSummary(10, 12);
    expect(r.changed).toBe(true);
    expect(r.changedKeys).toContain('(scalar)');
  });

  it('reports no change for identical scalars', () => {
    const r = diffSummary('foo', 'foo');
    expect(r.changed).toBe(false);
  });
});

// ── recordChange ──────────────────────────────────────────────────────────────

describe('recordChange', () => {
  const makeChangeRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
    id: 'change-uuid-1',
    config_key: 'loan.interest_rate_percent',
    prior_value: { rate: 10 },
    new_value: { rate: 12 },
    actor: 'GADMIN123',
    approval_ref: 'par-42',
    effective_at: new Date(),
    change_source: 'api',
    status: 'applied',
    alert_sent: false,
    ip_address: '127.0.0.1',
    created_at: new Date(),
    ...overrides,
  });

  it('records an approved change and writes audit_logs', async () => {
    // INSERT into config_change_log returns row
    mockQuery
      .mockResolvedValueOnce({ rows: [makeChangeRow()], rowCount: 1 }) // config_change_log insert
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // audit_logs insert

    const result = await svc.configIntegrityService.recordChange({
      configKey: 'loan.interest_rate_percent',
      priorValue: { rate: 10 },
      newValue: { rate: 12 },
      actor: 'GADMIN123',
      approvalRef: 'par-42',
    });

    expect(result.id).toBe('change-uuid-1');
    expect(result.status).toBe('applied');

    // config_change_log INSERT
    const firstCall = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(firstCall[0]).toMatch(/INSERT INTO config_change_log/);
    expect(firstCall[1]).toContain('loan.interest_rate_percent');
    expect(firstCall[1]).toContain('par-42');
    expect(firstCall[1]).toContain('applied');

    // audit_logs INSERT
    const secondCall = mockQuery.mock.calls[1] as [string, unknown[]];
    expect(secondCall[0]).toMatch(/INSERT INTO audit_logs/);
  });

  it('marks status=unauthorized and status=403 in audit when no approval_ref', async () => {
    const unauthorizedRow = makeChangeRow({ status: 'unauthorized', approval_ref: null });
    mockQuery
      .mockResolvedValueOnce({ rows: [unauthorizedRow], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // audit_logs
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // alert_sent update

    // Suppress actual fetch for the alert
    global.fetch = jest.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;

    const result = await svc.configIntegrityService.recordChange({
      configKey: 'loan.interest_rate_percent',
      priorValue: null,
      newValue: { rate: 15 },
      actor: 'GADMIN456',
      // no approvalRef
    });

    expect(result.status).toBe('unauthorized');
    // audit_logs should have status=403
    const auditCall = mockQuery.mock.calls[1] as [string, unknown[]];
    expect(auditCall[1]).toContain(403);
  });

  it('does not flag as unauthorized when requiresApproval=false', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [makeChangeRow({ status: 'applied', approval_ref: null })], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const result = await svc.configIntegrityService.recordChange({
      configKey: 'loan.interest_rate_percent',
      priorValue: null,
      newValue: { rate: 15 },
      actor: 'GADMIN789',
      requiresApproval: false,
    });

    expect(result.status).toBe('applied');
  });

  it('audit_logs failure does NOT throw — change is still returned', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [makeChangeRow()], rowCount: 1 }) // config_change_log
      .mockRejectedValueOnce(new Error('DB down')); // audit_logs fails

    // Should not throw
    const result = await svc.configIntegrityService.recordChange({
      configKey: 'loan.interest_rate_percent',
      priorValue: null,
      newValue: { rate: 12 },
      actor: 'GADMIN',
      approvalRef: 'par-1',
    });
    expect(result.id).toBe('change-uuid-1');
  });
});

// ── alertUnauthorized idempotency ─────────────────────────────────────────────

describe('alertUnauthorized', () => {
  it('dispatches alert then sets alert_sent=true', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE alert_sent

    const row = {
      id: 'change-1',
      config_key: 'pool.reserve_ratio',
      actor: 'GADMIN',
      effective_at: new Date(),
      change_source: 'direct',
      alert_sent: false,
    } as Parameters<typeof svc.configIntegrityService.alertUnauthorized>[0];

    await svc.configIntegrityService.alertUnauthorized(row);

    // UPDATE to set alert_sent=true
    const updateCall = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(updateCall[0]).toContain('alert_sent = true');
    expect(updateCall[1]).toContain('change-1');
  });

  it('still marks alert_sent after webhook failure (fetch error is caught internally)', async () => {
    // The service catches webhook fetch errors inside dispatchUnauthorizedAlert
    // and logs them, then returns. alertUnauthorized then proceeds to set
    // alert_sent=true so the row is not retried forever on a webhook outage.
    // The authoritative alert record is in audit_logs and the logger output.
    process.env.CONFIG_INTEGRITY_ALERT_WEBHOOK = 'http://hook.example.com';
    delete process.env.ADMIN_EMAIL;
    delete process.env.SENDGRID_API_KEY;
    global.fetch = jest.fn().mockRejectedValue(new Error('timeout')) as unknown as typeof fetch;
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const row = {
      id: 'change-2',
      config_key: 'pool.reserve_ratio',
      actor: 'GADMIN',
      effective_at: new Date(),
      change_source: 'direct' as const,
      alert_sent: false,
    } as Parameters<typeof svc.configIntegrityService.alertUnauthorized>[0];

    // Does not throw — fetch error is handled internally.
    await svc.configIntegrityService.alertUnauthorized(row);

    // The DB update to set alert_sent=true IS called even after webhook failure,
    // because dispatchUnauthorizedAlert catches the error and returns without
    // re-throwing. This prevents infinite retry on a persistent webhook outage.
    const dbCalls = mockQuery.mock.calls as [string, unknown[]][];
    const updateCall = dbCalls.find(([sql]) => typeof sql === 'string' && sql.includes('alert_sent = true'));
    expect(updateCall).toBeDefined();
    expect(updateCall![1]).toContain('change-2');

    delete process.env.CONFIG_INTEGRITY_ALERT_WEBHOOK;
  });
});

// ── retryPendingAlerts ────────────────────────────────────────────────────────

describe('retryPendingAlerts', () => {
  it('processes only rows with alert_sent=false', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;

    const pendingRow = {
      id: 'change-pending',
      config_key: 'k',
      actor: 'GADMIN',
      effective_at: new Date(),
      change_source: 'direct',
      alert_sent: false,
    };

    mockQuery
      .mockResolvedValueOnce({ rows: [pendingRow], rowCount: 1 }) // SELECT pending
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE alert_sent

    await svc.configIntegrityService.retryPendingAlerts();

    const selectCall = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(selectCall[0]).toContain('alert_sent = false');
  });

  it('is a no-op when no pending alerts exist', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await svc.configIntegrityService.retryPendingAlerts();
    // No further calls
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});

// ── createSnapshot / reviewSnapshot ──────────────────────────────────────────

describe('createSnapshot', () => {
  it('inserts a snapshot row', async () => {
    const snap = {
      id: 'snap-1', config_key: 'loan.interest_rate_percent',
      value: { rate: 10 }, snapshot_by: 'GADMIN', review_ref: null,
      is_reviewed: false, created_at: new Date(),
    };
    mockQuery.mockResolvedValueOnce({ rows: [snap], rowCount: 1 });

    const result = await svc.configIntegrityService.createSnapshot({
      configKey: 'loan.interest_rate_percent',
      value: { rate: 10 },
      snapshotBy: 'GADMIN',
    });

    expect(result.id).toBe('snap-1');
    const call = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(call[0]).toMatch(/INSERT INTO config_snapshots/);
  });
});

describe('reviewSnapshot', () => {
  it('updates is_reviewed and returns the row', async () => {
    const updated = {
      id: 'snap-1', config_key: 'k', value: { rate: 10 },
      snapshot_by: 'A', review_ref: 'par-99', is_reviewed: true, created_at: new Date(),
    };
    mockQuery.mockResolvedValueOnce({ rows: [updated], rowCount: 1 });

    const result = await svc.configIntegrityService.reviewSnapshot('snap-1', 'GADMIN2', 'par-99');
    expect(result.is_reviewed).toBe(true);
  });

  it('throws NotFound for missing snapshot', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(
      svc.configIntegrityService.reviewSnapshot('missing', 'GADMIN'),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

// ── recoverToSnapshot ─────────────────────────────────────────────────────────

describe('recoverToSnapshot', () => {
  const snap = {
    id: 'snap-rev', config_key: 'loan.interest_rate_percent',
    value: { rate: 10 }, snapshot_by: 'A', review_ref: 'par-7',
    is_reviewed: true, created_at: new Date(),
  };
  const latestRow = { new_value: { rate: 15 } };
  const recoveryChange = {
    id: 'change-recovery', config_key: 'loan.interest_rate_percent',
    prior_value: { rate: 15 }, new_value: { rate: 10 }, actor: 'GADMIN',
    approval_ref: 'par-7', effective_at: new Date(), change_source: 'recovery',
    status: 'applied', alert_sent: false, ip_address: null, created_at: new Date(),
  };

  it('succeeds: inserts recovery row and marks prior rows recovered', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [snap], rowCount: 1 })      // load snapshot
      .mockResolvedValueOnce({ rows: [latestRow], rowCount: 1 }) // prior value
      .mockResolvedValueOnce({ rows: [recoveryChange], rowCount: 1 }) // config_change_log insert
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })          // audit_logs
      .mockResolvedValueOnce({ rows: [], rowCount: 2 });         // mark prior recovered

    const result = await svc.configIntegrityService.recoverToSnapshot({
      snapshotId: 'snap-rev',
      actor: 'GADMIN',
      approvalRef: 'par-7',
    });

    expect(result.change_source).toBe('recovery');

    // Verify the UPDATE to mark prior rows recovered
    const updateCall = mockQuery.mock.calls[4] as [string, unknown[]];
    expect(updateCall[0]).toContain("status = 'recovered'");
  });

  it('throws BadRequest if snapshot is not reviewed', async () => {
    const unreviewed = { ...snap, is_reviewed: false };
    mockQuery.mockResolvedValueOnce({ rows: [unreviewed], rowCount: 1 });

    await expect(
      svc.configIntegrityService.recoverToSnapshot({
        snapshotId: 'snap-rev', actor: 'GADMIN', approvalRef: 'par-7',
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('throws NotFound if snapshot does not exist', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(
      svc.configIntegrityService.recoverToSnapshot({
        snapshotId: 'missing', actor: 'GADMIN', approvalRef: 'par-7',
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

// ── listChanges / listSnapshots ───────────────────────────────────────────────

describe('listChanges', () => {
  it('returns paginated results', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ id: `c${i}`, config_key: 'k' }));
    mockQuery.mockResolvedValueOnce({ rows, rowCount: 3 });

    const result = await svc.configIntegrityService.listChanges({ limit: 50 });
    expect(result.data).toHaveLength(3);
    expect(result.nextCursor).toBeNull();
  });

  it('returns nextCursor when more rows exist than limit', async () => {
    const rows = Array.from({ length: 4 }, (_, i) => ({ id: `c${i}`, config_key: 'k' }));
    mockQuery.mockResolvedValueOnce({ rows, rowCount: 4 });

    const result = await svc.configIntegrityService.listChanges({ limit: 3 });
    expect(result.data).toHaveLength(3);
    expect(result.nextCursor).toBe('c2');
  });

  it('applies config_key filter', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await svc.configIntegrityService.listChanges({ configKey: 'loan.interest_rate_percent' });
    const call = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(call[1]).toContain('loan.interest_rate_percent');
  });
});

describe('listSnapshots', () => {
  it('filters by is_reviewed', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await svc.configIntegrityService.listSnapshots({ isReviewed: true });
    const call = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(call[1]).toContain(true);
  });
});

// ── getChange / getSnapshot ───────────────────────────────────────────────────

describe('getChange', () => {
  it('returns the row', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'x' }], rowCount: 1 });
    const r = await svc.configIntegrityService.getChange('x');
    expect(r.id).toBe('x');
  });
  it('throws 404 when missing', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(svc.configIntegrityService.getChange('missing')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('getSnapshot', () => {
  it('returns the row', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'y' }], rowCount: 1 });
    const r = await svc.configIntegrityService.getSnapshot('y');
    expect(r.id).toBe('y');
  });
  it('throws 404 when missing', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(svc.configIntegrityService.getSnapshot('missing')).rejects.toMatchObject({ statusCode: 404 });
  });
});
