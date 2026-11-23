/**
 * Test suite for orphaned transaction reconciliation (issue #858).
 *
 * Coverage:
 *   A. State machine — success paths
 *      A1. tx found with SUCCESS  → state = confirmed, submission.status = confirmed
 *      A2. tx found with FAILED   → state = failed_on_chain, submission.status = failed
 *      A3. tx not found, inside finality window → state = finality_pending
 *      A4. tx not found, finality window elapsed → state = orphaned
 *
 *   B. detectNewOrphans — detection boundaries
 *      B1. does not detect submissions whose status is 'confirmed'
 *      B2. does not detect submissions whose status is 'failed'
 *      B3. does not detect submissions younger than the detection threshold
 *      B4. does not create a duplicate row when a reconciliation row already exists
 *      B5. inserts a pending_check row for a qualifying orphan candidate
 *
 *   C. Resubmission guard
 *      C1. approveResubmit succeeds from orphaned state
 *      C2. approveResubmit rejected in finality_pending with 409
 *      C3. approveResubmit rejected in confirmed with 409
 *      C4. approveResubmit rejected in failed_on_chain with 409
 *      C5. approveResubmit idempotent when already resubmitted
 *      C6. approveResubmit rejected when newTxHash equals original
 *      C7. approveResubmit rejected when newTxHash is empty
 *
 *   D. Manual resolution
 *      D1. resolveReconciliation succeeds with valid note
 *      D2. resolveReconciliation rejected when note < 10 chars
 *      D3. resolveReconciliation rejected when resolvedBy is empty
 *      D4. resolveReconciliation idempotent when already resolved
 *      D5. resolveReconciliation returns 404 for unknown id
 *
 *   E. Dependency-failure (RPC unavailable)
 *      E1. RPC error increments check_attempts without changing state
 *      E2. run() continues to next row after a per-row RPC failure
 *
 *   F. Access-control (HTTP layer)
 *      F1. GET /:txHash/reconciliation requires auth
 *      F2. JWT user cannot access another user's transaction
 *      F3. Admin API key may access any transaction
 *      F4. POST /:txHash/resubmit requires auth
 *      F5. Admin resolve endpoint requires admin:reconciliation key
 *
 *   G. Migration structure
 *      G1. migration file exports up() and down()
 *      G2. orphaned_tx_reconciliation state CHECK values match the service enum
 *      G3. down() removes both the new table and the added columns
 */

import { jest } from '@jest/globals';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { Keypair } from '@stellar/stellar-sdk';

process.env.JWT_SECRET = 'test-jwt-secret-min-32-chars-long!!';
process.env.INTERNAL_API_KEY = 'test_internal_api_key';

// ── DB mock ───────────────────────────────────────────────────────────────

type Res = { rows: unknown[]; rowCount?: number };
const mockQuery = jest.fn<(sql: string, params?: unknown[]) => Promise<Res>>();

jest.unstable_mockModule('../db/connection.js', () => ({
  default: { query: mockQuery },
  query: mockQuery,
  getClient: jest.fn(),
  closePool: jest.fn(),
  withTransaction: jest.fn(),
}));

jest.unstable_mockModule('../db/transaction.js', () => ({
  withTransaction: async (fn: (c: { query: typeof mockQuery }) => Promise<unknown>) =>
    fn({ query: mockQuery }),
}));

// ── Service imports (after mocks) ─────────────────────────────────────────

const {
  orphanedTxReconciler,
  approveResubmit,
  resolveReconciliation,
  getReconciliationByTxHash,
  getReconciliationById,
} = await import('../services/orphanedTxReconciler.js');

const { default: app } = await import('../app.js');

// ── Fixtures ──────────────────────────────────────────────────────────────

const OWNER = Keypair.random().publicKey();
const OTHER = Keypair.random().publicKey();
const TX_HASH = 'a'.repeat(64);
const NEW_TX_HASH = 'b'.repeat(64);

const NOW = new Date();
const PAST_DEADLINE = new Date(NOW.getTime() - 10_000);   // 10 s ago
const FUTURE_DEADLINE = new Date(NOW.getTime() + 300_000); // 5 min from now

function makeRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 1,
    submission_id: 10,
    tx_hash: TX_HASH,
    submitted_by: OWNER,
    transaction_type: 'loan',
    state: 'pending_check',
    check_attempts: 0,
    last_rpc_check_at: null,
    confirmed_ledger: null,
    rpc_result_xdr: null,
    rpc_error_detail: null,
    finality_deadline_at: FUTURE_DEADLINE.toISOString(),
    resubmit_approved_by: null,
    resubmitted_at: null,
    resubmit_tx_hash: null,
    resolution_note: null,
    resolved_by: null,
    resolved_at: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...overrides,
  };
}

function bearer(publicKey: string, scopes: string[] = ['write:loans', 'read:loans']) {
  return {
    Authorization: `Bearer ${jwt.sign(
      { publicKey, role: 'borrower', scopes },
      process.env.JWT_SECRET!,
      { algorithm: 'HS256', expiresIn: '1h' },
    )}`,
  };
}

const adminKey = { 'x-api-key': process.env.INTERNAL_API_KEY! };

// ── A. State machine — success paths ─────────────────────────────────────

describe('A. State machine — success paths', () => {
  afterEach(() => jest.resetAllMocks());

  it('A1. tx found SUCCESS → confirmed + submission.status = confirmed', async () => {
    // detectNewOrphans: 0 rows; fetchPendingRows: 1 row
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // detectNewOrphans INSERT
      .mockResolvedValueOnce({ rows: [makeRow()], rowCount: 1 }) // fetchPendingRows
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE orphaned_tx_reconciliation (confirmed)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE transaction_submissions

    const rpcLookup = jest.fn<() => Promise<unknown>>().mockResolvedValue({
      found: true,
      status: 'SUCCESS',
      ledger: 100,
      resultXdr: 'xdr==',
    });

    const result = await orphanedTxReconciler.run(rpcLookup as never);
    expect(result.confirmedCount).toBe(1);
    expect(result.orphanedCount).toBe(0);
    expect(result.errors).toBe(0);

    const updateCall = mockQuery.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes("state = 'confirmed'"),
    );
    expect(updateCall).toBeDefined();

    const submissionUpdate = mockQuery.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes("status = 'confirmed'"),
    );
    expect(submissionUpdate).toBeDefined();
  });

  it('A2. tx found FAILED → failed_on_chain + submission.status = failed', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [makeRow()], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const rpcLookup = jest.fn<() => Promise<unknown>>().mockResolvedValue({
      found: true,
      status: 'FAILED',
      ledger: 100,
      errorDetail: 'contract error',
    });

    const result = await orphanedTxReconciler.run(rpcLookup as never);
    expect(result.failedOnChainCount).toBe(1);
    expect(result.errors).toBe(0);

    const failUpdate = mockQuery.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes("state = 'failed_on_chain'"),
    );
    expect(failUpdate).toBeDefined();
  });

  it('A3. tx not found, inside finality window → finality_pending', async () => {
    // finality_deadline_at is in the future
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [makeRow({ finality_deadline_at: FUTURE_DEADLINE.toISOString() })],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const rpcLookup = jest.fn<() => Promise<unknown>>().mockResolvedValue({ found: false });

    const result = await orphanedTxReconciler.run(rpcLookup as never);
    expect(result.finalityPendingCount).toBe(1);
    expect(result.orphanedCount).toBe(0);

    const fp = mockQuery.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes("state = 'finality_pending'"),
    );
    expect(fp).toBeDefined();
  });

  it('A4. tx not found, finality window elapsed → orphaned', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [makeRow({ finality_deadline_at: PAST_DEADLINE.toISOString() })],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const rpcLookup = jest.fn<() => Promise<unknown>>().mockResolvedValue({ found: false });

    const result = await orphanedTxReconciler.run(rpcLookup as never);
    expect(result.orphanedCount).toBe(1);
    expect(result.finalityPendingCount).toBe(0);

    const orphaned = mockQuery.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes("state = 'orphaned'"),
    );
    expect(orphaned).toBeDefined();
  });
});

// ── B. detectNewOrphans — detection boundaries ────────────────────────────

describe('B. detectNewOrphans — detection boundaries', () => {
  afterEach(() => jest.resetAllMocks());

  it('B1–B5. detection INSERT query contains correct exclusions', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    await orphanedTxReconciler.detectNewOrphans();
    const sql = mockQuery.mock.calls[0]?.[0] as string;
    // B1-B2: excludes confirmed and failed
    expect(sql).toMatch(/status NOT IN.*'confirmed'.*'failed'/s);
    // B3: threshold applied
    expect(sql).toContain('submitted_at < NOW()');
    // B4: excludes rows that already have a reconciliation entry
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain('orphaned_tx_reconciliation');
    // B5: ON CONFLICT for idempotency
    expect(sql).toContain('ON CONFLICT (submission_id) DO NOTHING');
  });

  it('B5. returns the rowCount from the INSERT', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 3 });
    const count = await orphanedTxReconciler.detectNewOrphans();
    expect(count).toBe(3);
  });
});

// ── C. Resubmission guard ─────────────────────────────────────────────────

describe('C. Resubmission guard', () => {
  afterEach(() => jest.resetAllMocks());

  it('C1. approveResubmit succeeds from orphaned state', async () => {
    const orphanedRow = makeRow({ state: 'orphaned' });
    const updatedRow = makeRow({ state: 'resubmitted', resubmit_tx_hash: NEW_TX_HASH });
    // getReconciliationById (first call), UPDATE reconciliation, UPDATE submission, getReconciliationById (return)
    mockQuery
      .mockResolvedValueOnce({ rows: [orphanedRow], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [updatedRow], rowCount: 1 });

    const updated = await approveResubmit({
      reconciliationId: 1,
      approvedBy: OWNER,
      newTxHash: NEW_TX_HASH,
    });
    expect(updated.state).toBe('resubmitted');
    expect(updated.resubmitTxHash).toBe(NEW_TX_HASH);
  });

  it('C2. approveResubmit rejected in finality_pending with 409', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [makeRow({ state: 'finality_pending' })], rowCount: 1 });
    await expect(
      approveResubmit({ reconciliationId: 1, approvedBy: OWNER, newTxHash: NEW_TX_HASH }),
    ).rejects.toMatchObject({ statusCode: 409, errorCode: 'TX_RESUBMIT_BLOCKED' });
  });

  it('C3. approveResubmit rejected in confirmed with 409', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [makeRow({ state: 'confirmed' })], rowCount: 1 });
    await expect(
      approveResubmit({ reconciliationId: 1, approvedBy: OWNER, newTxHash: NEW_TX_HASH }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('C4. approveResubmit rejected in failed_on_chain with 409', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [makeRow({ state: 'failed_on_chain' })], rowCount: 1 });
    await expect(
      approveResubmit({ reconciliationId: 1, approvedBy: OWNER, newTxHash: NEW_TX_HASH }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('C5. approveResubmit idempotent when already resubmitted', async () => {
    const resubRow = makeRow({ state: 'resubmitted', resubmit_tx_hash: NEW_TX_HASH });
    mockQuery.mockResolvedValueOnce({ rows: [resubRow], rowCount: 1 });
    const result = await approveResubmit({
      reconciliationId: 1,
      approvedBy: OWNER,
      newTxHash: NEW_TX_HASH,
    });
    // Returns the existing row without additional DB writes
    expect(result.state).toBe('resubmitted');
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('C6. approveResubmit rejected when newTxHash equals original tx_hash', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [makeRow({ state: 'orphaned' })], rowCount: 1 });
    await expect(
      approveResubmit({ reconciliationId: 1, approvedBy: OWNER, newTxHash: TX_HASH }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('C7. approveResubmit rejected when newTxHash is empty', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [makeRow({ state: 'orphaned' })], rowCount: 1 });
    await expect(
      approveResubmit({ reconciliationId: 1, approvedBy: OWNER, newTxHash: '' }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

// ── D. Manual resolution ──────────────────────────────────────────────────

describe('D. Manual resolution', () => {
  afterEach(() => jest.resetAllMocks());

  it('D1. resolveReconciliation succeeds with valid note', async () => {
    const orphanedRow = makeRow({ state: 'orphaned' });
    const resolvedRow = makeRow({ state: 'resolved', resolved_by: OWNER });
    mockQuery
      .mockResolvedValueOnce({ rows: [orphanedRow], rowCount: 1 }) // getById
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })             // UPDATE reconciliation
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })             // UPDATE submission
      .mockResolvedValueOnce({ rows: [resolvedRow], rowCount: 1 }); // getById return
    const result = await resolveReconciliation({
      reconciliationId: 1,
      resolvedBy: OWNER,
      resolutionNote: 'confirmed as duplicate submission',
    });
    expect(result.state).toBe('resolved');
  });

  it('D2. resolveReconciliation rejected when note < 10 chars', async () => {
    await expect(
      resolveReconciliation({ reconciliationId: 1, resolvedBy: OWNER, resolutionNote: 'short' }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('D3. resolveReconciliation rejected when resolvedBy is empty', async () => {
    await expect(
      resolveReconciliation({
        reconciliationId: 1,
        resolvedBy: '',
        resolutionNote: 'this is long enough',
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('D4. resolveReconciliation idempotent when already resolved', async () => {
    const resolvedRow = makeRow({ state: 'resolved' });
    mockQuery.mockResolvedValueOnce({ rows: [resolvedRow], rowCount: 1 });
    const result = await resolveReconciliation({
      reconciliationId: 1,
      resolvedBy: OWNER,
      resolutionNote: 'this is long enough',
    });
    expect(result.state).toBe('resolved');
    // No further DB writes for already-resolved row.
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('D5. resolveReconciliation returns 404 for unknown id', async () => {
    // Input validation runs before DB for empty resolvedBy, so pass those.
    // But getReconciliationById returns no row.
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(
      resolveReconciliation({
        reconciliationId: 999,
        resolvedBy: OWNER,
        resolutionNote: 'this is long enough',
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

// ── E. Dependency-failure (RPC unavailable) ───────────────────────────────

describe('E. Dependency-failure (RPC unavailable)', () => {
  afterEach(() => jest.resetAllMocks());

  it('E1. RPC error increments check_attempts without changing state', async () => {
    const rpcError = new Error('RPC timeout');
    // fetchPendingRows returns one row
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })          // detectNewOrphans
      .mockResolvedValueOnce({ rows: [makeRow()], rowCount: 1 }) // fetchPendingRows
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })          // UPDATE attempts (error path)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });         // UPDATE submission last_checked_at

    const rpcLookup = jest.fn<() => Promise<never>>().mockRejectedValue(rpcError);

    const result = await orphanedTxReconciler.run(rpcLookup as never);
    // The error is counted but does not crash the run.
    expect(result.errors).toBe(1);
    expect(result.confirmedCount).toBe(0);
    expect(result.orphanedCount).toBe(0);

    // Check that the error-path UPDATE ran (increments attempts, does not change state)
    const errorUpdate = mockQuery.mock.calls.find(
      (c) =>
        typeof c[0] === 'string' &&
        c[0].includes('check_attempts = check_attempts + 1') &&
        c[0].includes('rpc_error_detail'),
    );
    expect(errorUpdate).toBeDefined();
  });

  it('E2. run() continues processing remaining rows after a per-row RPC failure', async () => {
    const row1 = makeRow({ id: 1, tx_hash: TX_HASH });
    const row2 = makeRow({ id: 2, tx_hash: 'c'.repeat(64), finality_deadline_at: PAST_DEADLINE.toISOString() });

    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [row1, row2], rowCount: 2 })
      // row1: RPC error path — 2 UPDATE calls
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      // row2: orphaned path — 2 UPDATE calls
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    let callCount = 0;
    const rpcLookup = jest.fn<() => Promise<unknown>>().mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) throw new Error('RPC unavailable');
      return { found: false };
    });

    const result = await orphanedTxReconciler.run(rpcLookup as never);
    expect(result.errors).toBe(1);
    expect(result.orphanedCount).toBe(1);
    expect(result.processed).toBe(2);
  });
});

// ── F. Access-control (HTTP layer) ────────────────────────────────────────

describe('F. Access-control (HTTP layer)', () => {
  afterEach(() => jest.resetAllMocks());

  it('F1. GET /:txHash/reconciliation returns 401 without auth', async () => {
    const res = await request(app).get(`/api/v1/transactions/${TX_HASH}/reconciliation`);
    expect(res.status).toBe(401);
  });

  it('F2. JWT user cannot access another user\'s transaction', async () => {
    // submission owned by OWNER, requester is OTHER
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 10,
          submitted_by: OWNER,
          tx_hash: TX_HASH,
          status: 'submitted',
          submitted_at: NOW.toISOString(),
          transaction_type: 'loan',
          reconciliation_state: null,
        },
      ],
      rowCount: 1,
    });
    const res = await request(app)
      .get(`/api/v1/transactions/${TX_HASH}/reconciliation`)
      .set(bearer(OTHER));
    expect(res.status).toBe(403);
  });

  it('F3. Admin API key may access any transaction', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          {
            id: 10,
            submitted_by: OWNER,
            tx_hash: TX_HASH,
            status: 'submitted',
            submitted_at: NOW.toISOString(),
            transaction_type: 'loan',
            reconciliation_state: null,
          },
        ],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // getReconciliationByTxHash → no row

    const res = await request(app)
      .get(`/api/v1/transactions/${TX_HASH}/reconciliation`)
      .set(adminKey);
    expect(res.status).toBe(200);
    expect(res.body.data.reconciliation).toBeNull();
  });

  it('F4. POST /:txHash/resubmit returns 401 without auth', async () => {
    const res = await request(app)
      .post(`/api/v1/transactions/${TX_HASH}/resubmit`)
      .send({ newTxHash: NEW_TX_HASH });
    expect(res.status).toBe(401);
  });

  it('F5. Admin resolve endpoint returns 401 without valid API key', async () => {
    const res = await request(app)
      .post(`/api/v1/admin/transactions/reconciliation/1/resolve`)
      .send({ resolvedBy: OWNER, resolutionNote: 'this is long enough' });
    // No x-api-key header → 401
    expect(res.status).toBe(401);
  });

  it('F5b. Admin resolve endpoint returns 403 with wrong-scoped API key', async () => {
    const res = await request(app)
      .post(`/api/v1/admin/transactions/reconciliation/1/resolve`)
      .set({ 'x-api-key': 'admin:indexer:test_internal_api_key' }) // wrong scope
      .send({ resolvedBy: OWNER, resolutionNote: 'this is long enough' });
    expect([401, 403]).toContain(res.status);
  });

  it('F6. POST /resubmit returns 404 when no reconciliation row exists', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // getReconciliationByTxHash
    const res = await request(app)
      .post(`/api/v1/transactions/${TX_HASH}/resubmit`)
      .set(bearer(OWNER))
      .send({ newTxHash: NEW_TX_HASH });
    expect(res.status).toBe(404);
  });

  it('F7. POST /resubmit returns 400 when newTxHash is missing', async () => {
    // No DB calls needed — validation fires first if reconciliation row is found
    mockQuery.mockResolvedValueOnce({ rows: [makeRow({ state: 'orphaned' })], rowCount: 1 });
    const res = await request(app)
      .post(`/api/v1/transactions/${TX_HASH}/resubmit`)
      .set(bearer(OWNER))
      .send({});
    expect(res.status).toBe(400);
  });

  it('F8. POST /resubmit returns 409 when state is finality_pending', async () => {
    // getReconciliationByTxHash → row
    mockQuery.mockResolvedValueOnce({
      rows: [makeRow({ state: 'finality_pending' })],
      rowCount: 1,
    });
    // getReconciliationById called by approveResubmit
    mockQuery.mockResolvedValueOnce({
      rows: [makeRow({ state: 'finality_pending' })],
      rowCount: 1,
    });
    const res = await request(app)
      .post(`/api/v1/transactions/${TX_HASH}/resubmit`)
      .set(bearer(OWNER))
      .send({ newTxHash: NEW_TX_HASH });
    expect(res.status).toBe(409);
  });
});

// ── G. Migration structure ─────────────────────────────────────────────────

describe('G. Migration structure', () => {
  it('G1. migration file exports up() and down()', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(
      resolve(process.cwd(), 'migrations/1809000000000_orphaned-tx-reconciliation.js'),
      'utf8',
    );
    expect(src).toContain('export const up');
    expect(src).toContain('export const down');
  });

  it('G2. state CHECK in migration covers all service enum values', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(
      resolve(process.cwd(), 'migrations/1809000000000_orphaned-tx-reconciliation.js'),
      'utf8',
    );
    const serviceStates = [
      'pending_check',
      'finality_pending',
      'confirmed',
      'failed_on_chain',
      'orphaned',
      'resubmitted',
      'resolved',
    ];
    for (const s of serviceStates) {
      expect(src).toContain(s);
    }
  });

  it('G3. down() removes the orphaned_tx_reconciliation table', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(
      resolve(process.cwd(), 'migrations/1809000000000_orphaned-tx-reconciliation.js'),
      'utf8',
    );
    expect(src).toContain("dropTable('orphaned_tx_reconciliation')");
    expect(src).toContain('dropColumns');
    expect(src).toContain('reconciliation_state');
  });

  it('G4. migration references update_updated_at_column() trigger', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(
      resolve(process.cwd(), 'migrations/1809000000000_orphaned-tx-reconciliation.js'),
      'utf8',
    );
    expect(src).toContain('update_updated_at_column');
  });
});
