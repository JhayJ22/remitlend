import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';

const OWNER = 'GOWNER0000000000000000000000000000000000000000000000001';
const OTHER = 'GOTHER0000000000000000000000000000000000000000000000001';
const OWNER_TX_ID = '11';
const OWNER_TX_HASH = 'tx-hash-owner';
const OTHER_TX_ID = '22';
const OTHER_TX_HASH = 'tx-hash-other';

type Row = Record<string, unknown>;
type QueryResult = { rows: Row[]; rowCount: number };

const transactions: Row[] = [
  {
    id: OWNER_TX_ID,
    tx_hash: OWNER_TX_HASH,
    submitted_by: OWNER,
    status: 'failed',
    submitted_at: new Date('2026-01-01T00:00:00Z').toISOString(),
    updated_at: new Date('2026-01-01T00:01:00Z').toISOString(),
    transaction_type: 'payment',
    result_xdr: 'OWNER-TX-RESULT-XDR',
  },
  {
    id: OTHER_TX_ID,
    tx_hash: OTHER_TX_HASH,
    submitted_by: OTHER,
    status: 'failed',
    submitted_at: new Date('2026-01-02T00:00:00Z').toISOString(),
    updated_at: new Date('2026-01-02T00:01:00Z').toISOString(),
    transaction_type: 'payment',
    result_xdr: 'OTHER-TX-RESULT-XDR',
  },
];

const bundles: Row[] = [];
let webhookRows: Row[] = [];
let failAuditLookup = false;
let failTransactionLookup = false;

const mockQuery = jest.fn<(sql: string, params?: unknown[]) => Promise<QueryResult>>();
mockQuery.mockImplementation(async (sql, params = []) => {
  const statement = String(sql).replace(/\s+/g, ' ').trim();

  if (statement.includes('FROM transaction_submissions')) {
    if (failTransactionLookup) throw new Error('database unavailable');
    const ref = String(params[0]);
    const caller = String(params[1]);
    const row = transactions.find(
      (candidate) =>
        (String(candidate.id) === ref || candidate.tx_hash === ref) &&
        candidate.submitted_by === caller,
    );
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  }

  if (statement.includes('FROM audit_logs')) {
    if (failAuditLookup) throw new Error('audit store unavailable');
    return { rows: [], rowCount: 0 };
  }

  if (statement.includes('INSERT INTO diagnostic_bundles')) {
    const row: Row = {
      id: String(bundles.length + 1),
      transaction_id: params[0],
      submitted_by: params[1],
      bundle: params[2],
      created_at: params[3],
      expires_at: params[4],
    };
    bundles.push(row);
    return { rows: [{ id: row.id }], rowCount: 1 };
  }

  if (statement.includes('UPDATE diagnostic_bundles')) {
    const bundle = bundles.find((candidate) => String(candidate.id) === String(params[1]));
    if (bundle) bundle.bundle = params[0];
    return { rows: [], rowCount: bundle ? 1 : 0 };
  }

  if (statement.includes('DELETE FROM diagnostic_bundles')) {
    const index = bundles.findIndex(
      (candidate) =>
        String(candidate.id) === String(params[0]) && candidate.submitted_by === params[1],
    );
    if (index === -1) return { rows: [], rowCount: 0 };
    const [removed] = bundles.splice(index, 1);
    return { rows: [removed as Row], rowCount: 1 };
  }

  if (statement.includes('FROM diagnostic_bundles')) {
    const row = bundles.find(
      (candidate) =>
        String(candidate.id) === String(params[0]) && candidate.submitted_by === params[1],
    );
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  }

  if (statement.includes('FROM webhook_deliveries')) {
    return { rows: webhookRows, rowCount: webhookRows.length };
  }

  if (statement.includes('UPDATE webhook_deliveries')) {
    return { rows: [], rowCount: 1 };
  }

  return { rows: [], rowCount: 0 };
});

jest.unstable_mockModule('../db/connection.js', () => {
  const connection = {
    query: mockQuery,
    getClient: jest.fn(),
    withTransaction: jest.fn(),
    on: jest.fn(),
    connect: jest.fn(),
  };
  return {
    default: connection,
    pool: connection,
    query: mockQuery,
    getClient: connection.getClient,
    withTransaction: connection.withTransaction,
    closePool: jest.fn(),
    PoolSaturatedError: class PoolSaturatedError extends Error {},
    TRANSIENT_ERROR_CODES: new Set<string>(),
  };
});

const mockAuditLog = jest.fn<() => Promise<void>>(async () => undefined);
jest.unstable_mockModule('../services/auditLogService.js', () => ({
  auditLogService: { log: mockAuditLog },
  getAuditLogs: jest.fn(async () => ({ rows: [], total: 0 })),
}));

jest.unstable_mockModule('../middleware/jwtAuth.js', () => ({
  requireJwtAuth: (req: Request & { user?: unknown }, _res: Response, next: NextFunction) => {
    const wallet = req.header('x-test-wallet');
    if (!wallet) {
      next(new Error('UNAUTHENTICATED'));
      return;
    }
    req.user = { publicKey: wallet, role: 'borrower', scopes: [] };
    next();
  },
}));

jest.unstable_mockModule('../services/jobMetricsService.js', () => ({
  jobMetricsService: {
    recordSuccess: jest.fn(),
    recordFailure: jest.fn(),
  },
}));

jest.unstable_mockModule('../services/webhookEgress.js', () => ({
  WebhookEgressPolicyError: class WebhookEgressPolicyError extends Error {},
  validateWebhookUrl: jest.fn(async () => undefined),
  sendWebhookRequest: jest.fn(),
}));

const fetchMock =
  jest.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>();

jest.unstable_mockModule('../config/stellar.js', () => ({
  createSorobanRpcServer: jest.fn(),
  getStellarNetworkPassphrase: jest.fn(() => 'Test SDF Network ; September 2015'),
  getStellarRpcUrl: jest.fn(() => 'https://soroban-testnet.stellar.org'),
}));

jest.unstable_mockModule('../services/sorobanCircuitBreaker.js', () => ({
  sorobanCircuitBreaker: { checkAvailability: jest.fn(async () => ({ available: true })) },
}));

const { DiagnosticBundleService, DiagnosticBundleError } =
  await import('../services/diagnosticBundleService.js');
const { WebhookService, redactFailureSummary } = await import('../services/webhookService.js');
const { runSorobanWriteReplayOnce } = await import('../services/sorobanWriteReplayProcessor.js');

const transactionRoutes = (await import('../routes/transactionRoutes.js')).default;

const app = express();
app.use(express.json());
app.use('/api/transactions', transactionRoutes);
app.use(
  (
    err: Error & { statusCode?: number; errorCode?: string },
    _req: Request,
    res: Response,
    _next: NextFunction,
  ) => {
    if (err.message === 'UNAUTHENTICATED') {
      res.status(401).json({
        success: false,
        message: 'Authentication required',
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
      return;
    }
    res.status(err.statusCode ?? 500).json({
      success: false,
      message: err.message,
      error: { code: err.errorCode ?? 'INTERNAL_ERROR', message: err.message },
    });
  },
);

type Service = InstanceType<typeof DiagnosticBundleService>;
const service: Service = new DiagnosticBundleService({
  query: mockQuery,
} as unknown as ConstructorParameters<typeof DiagnosticBundleService>[0]);

const token = (publicKey: string) => publicKey;

function storedBundle(id: string): Row | undefined {
  return bundles.find((candidate) => String(candidate.id) === id);
}

function parseBundle(row: Row | undefined): Row {
  if (!row) return {};
  return typeof row.bundle === 'string' ? (JSON.parse(row.bundle) as Row) : (row.bundle as Row);
}

describe('tenant isolation: diagnostic export', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    bundles.length = 0;
    webhookRows = [];
    failAuditLookup = false;
    failTransactionLookup = false;
  });

  it('exports only the caller-owned transaction and omits raw XDR identifiers', async () => {
    const result = await service.createDiagnosticBundle(OWNER_TX_HASH, OWNER);
    const row = storedBundle(result.bundleId);
    const contents = parseBundle(row);
    const serialized = JSON.stringify(contents);

    expect(row?.submitted_by).toBe(OWNER);
    expect((contents.transaction as Row)?.txHash).toBe(OWNER_TX_HASH);
    expect(serialized).not.toContain('OWNER-TX-RESULT-XDR');
    expect(serialized).not.toContain('OTHER-TX-RESULT-XDR');
    expect(result.expiresAt).toBe(contents.expiresAt);
  });

  it('returns the identical 404 for a foreign transaction and a missing transaction', async () => {
    let foreignError: unknown;
    let missingError: unknown;
    try {
      await service.createDiagnosticBundle(OWNER_TX_HASH, OTHER);
    } catch (error) {
      foreignError = error;
    }
    try {
      await service.createDiagnosticBundle('does-not-exist', OTHER);
    } catch (error) {
      missingError = error;
    }

    expect(foreignError).toBeInstanceOf(DiagnosticBundleError);
    expect(missingError).toBeInstanceOf(DiagnosticBundleError);
    const foreign = foreignError as DiagnosticBundleError;
    const missing = missingError as DiagnosticBundleError;
    expect([foreign.code, foreign.statusCode, foreign.message]).toEqual([
      'not_found',
      404,
      'Transaction not found',
    ]);
    expect([missing.code, missing.statusCode, missing.message]).toEqual([
      foreign.code,
      foreign.statusCode,
      foreign.message,
    ]);
    expect(bundles).toHaveLength(0);
  });

  it('never issues an unscoped transaction or bundle lookup', async () => {
    await service.createDiagnosticBundle(OWNER_TX_HASH, OTHER).catch(() => undefined);

    const transactionQueries = mockQuery.mock.calls.filter(([sql]) =>
      String(sql).includes('FROM transaction_submissions'),
    );
    expect(transactionQueries).toHaveLength(1);
    expect(transactionQueries[0]?.[1]).toEqual([OWNER_TX_HASH, OTHER]);
    expect(String(transactionQueries[0]?.[0])).toContain('submitted_by = $2');
  });

  it('denies cross-tenant reads with the same response and query count as a missing bundle', async () => {
    const created = await service.createDiagnosticBundle(OWNER_TX_HASH, OWNER);
    const before = mockQuery.mock.calls.length;

    let foreignError: unknown;
    try {
      await service.getDiagnosticBundle(created.bundleId, OTHER);
    } catch (error) {
      foreignError = error;
    }
    const foreignQueries = mockQuery.mock.calls.length - before;

    const beforeMissing = mockQuery.mock.calls.length;
    let missingError: unknown;
    try {
      await service.getDiagnosticBundle('999999', OTHER);
    } catch (error) {
      missingError = error;
    }
    const missingQueries = mockQuery.mock.calls.length - beforeMissing;

    expect(foreignQueries).toBe(missingQueries);
    expect(foreignError).toBeInstanceOf(DiagnosticBundleError);
    expect((foreignError as DiagnosticBundleError).message).toBe(
      (missingError as DiagnosticBundleError).message,
    );
    expect(JSON.stringify(foreignError)).not.toContain(OWNER_TX_HASH);
    expect(parseBundle(storedBundle(created.bundleId))).toHaveProperty('transaction');
  });

  it("does not delete another tenant's bundle and rejects stale handles", async () => {
    const created = await service.createDiagnosticBundle(OWNER_TX_HASH, OWNER);

    await expect(service.deleteDiagnosticBundle(created.bundleId, OTHER)).rejects.toMatchObject({
      code: 'not_found',
      statusCode: 404,
    });
    expect(storedBundle(created.bundleId)).toBeDefined();

    const deleteCalls = mockQuery.mock.calls.filter(([sql]) =>
      String(sql).includes('DELETE FROM diagnostic_bundles'),
    );
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0]?.[1]).toEqual([created.bundleId, OTHER]);
    expect(String(deleteCalls[0]?.[0])).toContain('submitted_by = $2');

    await service.deleteDiagnosticBundle(created.bundleId, OWNER);
    await expect(service.getDiagnosticBundle(created.bundleId, OWNER)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('rejects an expired export without returning its contents', async () => {
    const created = await service.createDiagnosticBundle(OWNER_TX_HASH, OWNER, { ttlMs: 1000 });
    const row = storedBundle(created.bundleId);
    if (row) row.expires_at = new Date(Date.now() - 1000);

    await expect(service.getDiagnosticBundle(created.bundleId, OWNER)).rejects.toMatchObject({
      code: 'expired',
      statusCode: 410,
    });
  });

  it('keeps audit-correlation dependency failure best-effort and fails closed on primary DB failure', async () => {
    failAuditLookup = true;
    const created = await service.createDiagnosticBundle(OWNER_TX_HASH, OWNER);
    expect(storedBundle(created.bundleId)).toBeDefined();
    expect(mockAuditLog).toHaveBeenCalled();

    failTransactionLookup = true;
    await expect(service.createDiagnosticBundle(OWNER_TX_HASH, OWNER)).rejects.toThrow(
      'database unavailable',
    );
    expect(bundles).toHaveLength(1);
  });
});

describe('tenant isolation: API export probes', () => {
  beforeEach(() => {
    bundles.length = 0;
    failAuditLookup = false;
    failTransactionLookup = false;
  });

  it('rejects unauthenticated export access with 401', async () => {
    const res = await request(app)
      .post(`/api/transactions/${OWNER_TX_HASH}/diagnostic-bundle`)
      .set('Idempotency-Key', 'tenant-anon-1')
      .send({ confirm: true });
    expect(res.status).toBe(401);
  });

  it('returns byte-equivalent 404 bodies for a foreign owner and a missing transaction', async () => {
    const foreign = await request(app)
      .post(`/api/transactions/${OWNER_TX_HASH}/diagnostic-bundle`)
      .set('x-test-wallet', token(OTHER))
      .set('Idempotency-Key', 'tenant-foreign-1')
      .send({ confirm: true });
    const missing = await request(app)
      .post('/api/transactions/no-such-transaction/diagnostic-bundle')
      .set('x-test-wallet', token(OTHER))
      .set('Idempotency-Key', 'tenant-missing-1')
      .send({ confirm: true });

    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(foreign.body).toEqual(missing.body);
    expect(JSON.stringify(foreign.body)).not.toContain(OWNER_TX_HASH);
    expect(JSON.stringify(foreign.body)).not.toContain('OWNER-TX-RESULT-XDR');
  });

  it('does not disclose bundle identifiers through cross-tenant GET or DELETE', async () => {
    const created = await service.createDiagnosticBundle(OWNER_TX_HASH, OWNER);
    const path = `/api/transactions/${OWNER_TX_HASH}/diagnostic-bundle/${created.bundleId}`;

    const foreignGet = await request(app).get(path).set('x-test-wallet', token(OTHER));
    const missingGet = await request(app)
      .get(`/api/transactions/${OWNER_TX_HASH}/diagnostic-bundle/999999`)
      .set('x-test-wallet', token(OTHER));
    expect(foreignGet.status).toBe(404);
    expect(foreignGet.body).toEqual(missingGet.body);
    expect(JSON.stringify(foreignGet.body)).not.toContain(created.bundleId);

    const foreignDelete = await request(app)
      .delete(path)
      .set('x-test-wallet', token(OTHER))
      .set('Idempotency-Key', 'tenant-foreign-delete-1');
    const missingDelete = await request(app)
      .delete(`/api/transactions/${OWNER_TX_HASH}/diagnostic-bundle/999999`)
      .set('x-test-wallet', token(OTHER))
      .set('Idempotency-Key', 'tenant-missing-delete-1');
    expect(foreignDelete.status).toBe(404);
    expect(foreignDelete.body).toEqual(missingDelete.body);
    expect(storedBundle(created.bundleId)).toBeDefined();
  });

  it('requires explicit confirmation and rejects invalid input without side effects', async () => {
    const res = await request(app)
      .post(`/api/transactions/${OWNER_TX_HASH}/diagnostic-bundle`)
      .set('x-test-wallet', token(OWNER))
      .set('Idempotency-Key', 'tenant-invalid-confirm-1')
      .send({ confirm: false });
    expect(res.status).toBe(400);
    expect(bundles).toHaveLength(0);
  });
});

describe('tenant isolation: retry and worker paths', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    webhookRows = [];
    failAuditLookup = false;
    failTransactionLookup = false;
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => ({ ok: true, status: 200 }) as Response);
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('delivers each queued webhook payload only to its own subscriber callback', async () => {
    webhookRows = [
      {
        id: 1,
        subscription_id: 101,
        callback_url: 'https://tenant-a.example.com/hook',
        secret: null,
        event_id: 'evt-a',
        event_type: 'LoanApproved',
        payload: { eventId: 'evt-a', tenant: 'A', loanId: 'loan-a' },
        attempt_count: 0,
        delivery_generation: 1,
      },
      {
        id: 2,
        subscription_id: 202,
        callback_url: 'https://tenant-b.example.com/hook',
        secret: null,
        event_id: 'evt-b',
        event_type: 'LoanApproved',
        payload: { eventId: 'evt-b', tenant: 'B', loanId: 'loan-b' },
        attempt_count: 0,
        delivery_generation: 1,
      },
    ];

    await WebhookService.processRetries();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [urlA, initA] = fetchMock.mock.calls[0]!;
    const [urlB, initB] = fetchMock.mock.calls[1]!;
    expect(String(urlA)).toContain('tenant-a.example.com');
    expect(String(urlB)).toContain('tenant-b.example.com');
    expect(String(initA?.body)).toContain('loan-a');
    expect(String(initA?.body)).not.toContain('loan-b');
    expect(String(initB?.body)).toContain('loan-b');
    expect(String(initB?.body)).not.toContain('loan-a');

    const updates = mockQuery.mock.calls.filter(([sql]) =>
      String(sql).includes('UPDATE webhook_deliveries'),
    );
    expect(updates).toHaveLength(2);
    expect(updates[0]?.[1]).toEqual(expect.arrayContaining([1]));
    expect(updates[1]?.[1]).toEqual(expect.arrayContaining([2]));
  });

  it('continues after a dependency failure and redacts foreign identifiers from error summaries', async () => {
    const failing = new Error(
      'POST https://tenant-a.example.com/hook failed with token SECRET-TOKEN-AAAAAAAAAAAAAAAAAAAAAAAA',
    );
    fetchMock
      .mockImplementationOnce(async () => {
        throw failing;
      })
      .mockImplementationOnce(async () => ({ ok: true, status: 200 }) as Response);

    webhookRows = [
      {
        id: 7,
        subscription_id: 101,
        callback_url: 'https://tenant-a.example.com/hook',
        secret: null,
        event_id: 'evt-a',
        event_type: 'LoanApproved',
        payload: { eventId: 'evt-a', tenant: 'A' },
        attempt_count: 0,
        delivery_generation: 1,
      },
      {
        id: 8,
        subscription_id: 202,
        callback_url: 'https://tenant-b.example.com/hook',
        secret: null,
        event_id: 'evt-b',
        event_type: 'LoanApproved',
        payload: { eventId: 'evt-b', tenant: 'B' },
        attempt_count: 0,
        delivery_generation: 1,
      },
    ];

    await WebhookService.processRetries();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const redacted = redactFailureSummary(failing.message);
    expect(redacted).not.toContain('tenant-a.example.com');
    expect(redacted).not.toContain('SECRET-TOKEN-AAAAAAAAAAAAAAAAAAAAAAAA');
  });

  it('replays queued writes in order without mixing tenant payloads or overtaking a failure', async () => {
    const submissions: Array<{ id: number; payload: Record<string, unknown> }> = [];
    const queue = {
      listReadyForReplay: jest.fn(async () => [
        {
          id: 1,
          idempotencyKey: 'idem-a',
          operation: 'loan-a',
          payload: { tenant: 'A', loanId: 'loan-a' },
          status: 'pending',
          attempts: 0,
          lastError: null,
          nextAttemptAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        {
          id: 2,
          idempotencyKey: 'idem-b',
          operation: 'loan-b',
          payload: { tenant: 'B', loanId: 'loan-b' },
          status: 'pending',
          attempts: 0,
          lastError: null,
          nextAttemptAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ]),
      markApplied: jest.fn(async () => undefined),
      markFailed: jest.fn(async () => new Date(Date.now() + 1000)),
    };

    const result = await runSorobanWriteReplayOnce({
      queue: queue as never,
      isAvailable: async () => true,
      submit: async (write) => {
        submissions.push({ id: write.id, payload: write.payload });
        if (write.id === 1) throw new Error('rpc unavailable for loan-a');
        return { txHash: 'hash-b' };
      },
    });

    expect(result).toMatchObject({ considered: 1, applied: 0, failed: 1 });
    expect(submissions).toHaveLength(1);
    expect(submissions[0]?.payload).toEqual({ tenant: 'A', loanId: 'loan-a' });
    expect(queue.markApplied).not.toHaveBeenCalled();
    expect(queue.markFailed).toHaveBeenCalledTimes(1);
  });
});
