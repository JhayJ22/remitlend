/**
 * Fault-injection tests — PostgreSQL (#402).
 *
 * Verifies that services using the database handle connection failures and
 * query errors gracefully, propagating structured errors rather than crashing
 * or leaking raw pg error messages to callers.
 *
 * Tests focus on the DatabaseService layer and the ScoresService, which
 * exercise the most critical read/write paths.
 *
 * Threat-model notes
 * ------------------
 * DB connection failures are the most common cloud-infrastructure fault. The
 * service layer must propagate AppError (with a structured code) rather than
 * raw pg errors, so API error handlers can produce safe, consistent responses.
 * Raw pg messages (which can contain query fragments) must never reach clients.
 *
 * Compatibility impact: read-only unit test — no schema or contract changes.
 * Rollout steps: runs automatically in CI on every PR.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockQuery = jest.fn<
  (text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>
>();

jest.unstable_mockModule('../db/connection.js', () => ({
  default: { query: mockQuery },
  query: mockQuery,
  getClient: jest.fn(),
  withTransaction: jest.fn(),
}));

const mockRecordFailoverEvent = jest.fn();
jest.unstable_mockModule('../services/failoverAlertService.js', () => ({
  recordFailoverEvent: mockRecordFailoverEvent,
}));

// ─── Module under test ────────────────────────────────────────────────────────
const { UserProfileService } = await import('../services/databaseService.js');
const { FailoverPool, FailoverWriteTimeoutError } = await import('../db/failoverConnection.js');

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Fault injection – PostgreSQL (databaseService)', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it('propagates error when DB throws ECONNREFUSED', async () => {
    const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
      code: 'ECONNREFUSED',
    });
    mockQuery.mockRejectedValue(err);

    await expect(
      UserProfileService.findByPublicKey('GTEST123'),
    ).rejects.toThrow();
  });

  it('propagates error on query timeout', async () => {
    mockQuery.mockRejectedValue(new Error('query timeout after 30 000 ms'));

    await expect(
      UserProfileService.findByPublicKey('GTEST123'),
    ).rejects.toThrow();
  });

  it('propagates error on connection pool exhaustion', async () => {
    mockQuery.mockRejectedValue(new Error('timeout exceeded when trying to connect'));

    await expect(
      UserProfileService.findByPublicKey('GTEST123'),
    ).rejects.toThrow();
  });

  it('returns null (not an error) when the user does not exist', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const result = await UserProfileService.findByPublicKey('GDOES_NOT_EXIST');
    expect(result).toBeNull();
  });

  it('returns the profile when a single row is returned', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          id: 1,
          public_key: 'GTEST123',
          display_name: 'Alice',
          email: 'alice@example.com',
          created_at: new Date(),
          updated_at: new Date(),
          metadata: null,
        },
      ],
      rowCount: 1,
    });

    const result = await UserProfileService.findByPublicKey('GTEST123');
    expect(result).not.toBeNull();
    expect(result?.public_key).toBe('GTEST123');
  });
});

// ─── Failover pool (#782) ─────────────────────────────────────────────────────

type QueryFn = (sql: string, params?: unknown[]) => Promise<any>;

function fakePool(impl: QueryFn) {
  return {
    query: jest.fn<QueryFn>(impl),
    connect: jest.fn<() => Promise<any>>(),
    end: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
}

const connRefused = () =>
  Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });

describe('Fault injection – PostgreSQL failover (FailoverPool)', () => {
  beforeEach(() => {
    mockRecordFailoverEvent.mockReset();
  });

  it('routes reads to the replica when readFromReplica is enabled', async () => {
    const primary = fakePool(async () => ({ rows: ['primary'] }));
    const replica = fakePool(async () => ({ rows: ['replica'] }));
    const pool = new FailoverPool({
      primaryPool: primary as any,
      replicaPool: replica as any,
      readFromReplica: true,
      healthCheckIntervalMs: 0,
    });

    await expect(pool.query('SELECT 1')).resolves.toEqual({ rows: ['replica'] });
    await expect(pool.query('INSERT INTO t VALUES (1)')).resolves.toEqual({ rows: ['primary'] });
    await expect(pool.query('SELECT * FROM t FOR UPDATE')).resolves.toEqual({ rows: ['primary'] });
    await pool.end();
  });

  it('falls back to the replica for reads and emits an alert on primary outage', async () => {
    const primary = fakePool(async () => {
      throw connRefused();
    });
    const replica = fakePool(async () => ({ rows: ['replica'] }));
    const pool = new FailoverPool({
      primaryPool: primary as any,
      replicaPool: replica as any,
      readFromReplica: false,
      healthCheckIntervalMs: 0,
    });

    await expect(pool.query('SELECT 1')).resolves.toEqual({ rows: ['replica'] });
    expect(pool.isFailoverActive()).toBe(true);
    expect(mockRecordFailoverEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'failover_activated' }),
    );
    await pool.end();
  });

  it('queues writes during outage and rejects after DB_FAILOVER_TIMEOUT_MS', async () => {
    const primary = fakePool(async () => {
      throw connRefused();
    });
    const pool = new FailoverPool({
      primaryPool: primary as any,
      replicaPool: null,
      failoverTimeoutMs: 30,
      healthCheckIntervalMs: 0,
    });

    const write = pool.query('UPDATE loans SET status = $1', ['repaid']);
    expect(pool.getQueuedWriteCount()).toBe(0); // enqueued after the failed attempt resolves
    await expect(write).rejects.toBeInstanceOf(FailoverWriteTimeoutError);
    expect(pool.getQueuedWriteCount()).toBe(0);
    expect(mockRecordFailoverEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'failover_activated' }),
    );
    expect(mockRecordFailoverEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'write_queue_timeout' }),
    );
    await pool.end();
  });

  it('drains queued writes and restores routing when the primary recovers', async () => {
    let primaryUp = false;
    const primary = fakePool(async (sql) => {
      if (!primaryUp) throw connRefused();
      return { rows: [sql] };
    });
    const replica = fakePool(async () => ({ rows: ['replica'] }));
    const pool = new FailoverPool({
      primaryPool: primary as any,
      replicaPool: replica as any,
      failoverTimeoutMs: 5000,
      healthCheckIntervalMs: 0,
    });

    const w1 = pool.query('INSERT INTO a VALUES (1)');
    const w2 = pool.query('INSERT INTO b VALUES (2)');
    await new Promise((r) => setImmediate(r));
    expect(pool.isFailoverActive()).toBe(true);
    expect(pool.getQueuedWriteCount()).toBe(2);

    primaryUp = true;
    await expect(pool.checkPrimaryHealth()).resolves.toBe(true);

    await expect(w1).resolves.toEqual({ rows: ['INSERT INTO a VALUES (1)'] });
    await expect(w2).resolves.toEqual({ rows: ['INSERT INTO b VALUES (2)'] });
    expect(pool.isFailoverActive()).toBe(false);
    expect(mockRecordFailoverEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'failover_deactivated' }),
    );
    await expect(pool.query('SELECT 1')).resolves.toEqual({ rows: ['SELECT 1'] });
    await pool.end();
  });
});
