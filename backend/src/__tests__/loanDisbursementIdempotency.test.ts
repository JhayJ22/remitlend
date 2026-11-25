/**
 * Loan disbursement idempotency (#756).
 *
 * Mirrors remittanceIdempotency.test.ts at the HTTP boundary and adds the two
 * chain-specific guarantees: a cold idempotency cache with a durable
 * submission row polls instead of re-submitting, and Horizon's
 * `tx_already_applied` response is a success rather than a 500.
 */

import request from 'supertest';
import { jest } from '@jest/globals';
import {
  Account,
  Asset,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = 'test-jwt-secret-min-32-chars-long!!';
const ADMIN = Keypair.random().publicKey();
process.env.ADMIN_WALLETS = ADMIN;
process.env.STELLAR_NETWORK = 'testnet';

function buildSignedXdr(): string {
  const keypair = Keypair.random();
  const account = new Account(keypair.publicKey(), '1');
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: keypair.publicKey(),
        asset: Asset.native(),
        amount: '1',
      }),
    )
    .setTimeout(30)
    .build();
  tx.sign(keypair);
  return tx.toXDR();
}

const SIGNED_XDR = buildSignedXdr();

interface SubmissionRow {
  id: number;
  idempotency_key: string;
  tx_hash: string;
  status: string;
  submitted_at: Date;
  submitted_by: string;
  transaction_type: string;
  envelope_xdr: string;
  result_xdr: string | null;
}

const submissions: SubmissionRow[] = [];
let nextSubmissionId = 1;

const computeHash = (xdr: string): string =>
  TransactionBuilder.fromXDR(xdr, Networks.TESTNET).hash().toString('hex');

const mockQuery = jest.fn(async (text: string, params?: unknown[]) => {
  const sql = text.replace(/\s+/g, ' ').trim();
  if (sql.includes('FROM transaction_submissions') && sql.includes('WHERE idempotency_key = $1')) {
    const row = submissions.find((s) => s.idempotency_key === params?.[0]);
    return { rows: row ? [row] : [] };
  }
  if (sql.includes('FROM transaction_submissions') && sql.includes('WHERE tx_hash = $1')) {
    const row = submissions.find((s) => s.tx_hash === params?.[0]);
    return { rows: row ? [row] : [] };
  }
  if (sql.startsWith('INSERT INTO transaction_submissions')) {
    if (submissions.some((s) => s.tx_hash === params?.[1])) return { rows: [] };
    const row = {
      id: nextSubmissionId++,
      idempotency_key: String(params?.[0]),
      tx_hash: String(params?.[1]),
      status: 'PENDING',
      submitted_at: new Date(),
      submitted_by: String(params?.[2]),
      transaction_type: 'loan',
      envelope_xdr: String(params?.[3]),
      result_xdr: null,
    };
    submissions.push(row);
    return { rows: [{ id: row.id }] };
  }
  if (sql.startsWith('UPDATE transaction_submissions')) {
    const row = submissions.find((s) => s.idempotency_key === params?.[2]);
    if (row) {
      row.status = String(params?.[0]);
      row.result_xdr = params?.[1] === null ? null : String(params?.[1]);
    }
    return { rows: [] };
  }
  return { rows: [] };
});

jest.unstable_mockModule('../db/connection.js', () => ({
  default: { query: mockQuery },
  query: mockQuery,
  getClient: jest.fn(),
  closePool: jest.fn(),
  withTransaction: jest.fn(),
}));

const fakeCacheStore = new Map<string, unknown>();
jest.unstable_mockModule('../services/cacheService.js', () => ({
  cacheService: {
    get: jest.fn(async (key: string) => fakeCacheStore.get(key) ?? null),
    set: jest.fn(async (key: string, value: unknown) => {
      fakeCacheStore.set(key, value);
    }),
    delete: jest.fn(async (key: string) => {
      fakeCacheStore.delete(key);
    }),
    invalidateByPattern: jest.fn(async () => undefined),
  },
}));

const mockSubmitSignedTx = jest.fn<
  () => Promise<{ txHash: string; status: string; resultXdr?: string }>
>();
const mockPollTransactionByHash = jest.fn<
  () => Promise<{ status: string; resultXdr?: string; alreadyApplied?: boolean }>
>();

jest.unstable_mockModule('../services/sorobanService.js', () => ({
  sorobanService: {
    submitSignedTx: mockSubmitSignedTx,
    pollTransactionByHash: mockPollTransactionByHash,
  },
}));

const { default: app } = await import('../app.js');

const adminBearer = () => ({
  Authorization: `Bearer ${jwt.sign(
    { publicKey: ADMIN, role: 'admin', scopes: ['admin:all'] },
    process.env.JWT_SECRET!,
    { algorithm: 'HS256', expiresIn: '1h' },
  )}`,
});

const postDisburse = (idempotencyKey: string) =>
  request(app)
    .post('/api/admin/loans/42/disburse')
    .set(adminBearer())
    .set('Idempotency-Key', idempotencyKey)
    .send({ signedTxXdr: SIGNED_XDR });

beforeEach(() => {
  jest.clearAllMocks();
  fakeCacheStore.clear();
  submissions.length = 0;
  nextSubmissionId = 1;
  mockSubmitSignedTx.mockResolvedValue({
    txHash: computeHash(SIGNED_XDR),
    status: 'SUCCESS',
  });
  mockPollTransactionByHash.mockResolvedValue({ status: 'SUCCESS' });
});

describe('POST /api/admin/loans/:loanId/disburse idempotency (#756)', () => {
  const payload = { signedTxXdr: SIGNED_XDR };

  it('submits exactly one Soroban transaction for two identical requests sharing an Idempotency-Key', async () => {
    const first = await postDisburse('disburse-key-1');
    expect(first.status).toBe(200);
    expect(first.headers['x-idempotent-replayed']).toBe('false');
    expect(first.body.success).toBe(true);

    const second = await postDisburse('disburse-key-1');
    expect(second.status).toBe(200);
    expect(second.headers['x-idempotent-replayed']).toBe('true');
    expect(second.body).toEqual(first.body);

    expect(mockSubmitSignedTx).toHaveBeenCalledTimes(1);
    expect(submissions).toHaveLength(1);
  });

  it('records the XDR hash before submission and polls (never re-submits) when the cache is cold', async () => {
    const first = await postDisburse('disburse-key-2');
    expect(first.status).toBe(200);
    expect(mockSubmitSignedTx).toHaveBeenCalledTimes(1);
    expect(submissions[0].tx_hash).toBe(computeHash(SIGNED_XDR));

    // Simulate an HTTP timeout after submission: the middleware never cached a
    // response, but the durable submission row exists.
    fakeCacheStore.clear();
    mockSubmitSignedTx.mockClear();

    const replay = await postDisburse('disburse-key-2');
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    expect(replay.headers['x-idempotent-replayed']).toBe('true');
    expect(mockSubmitSignedTx).not.toHaveBeenCalled();
    expect(mockPollTransactionByHash).toHaveBeenCalledWith(computeHash(SIGNED_XDR));
  });

  it('does not re-submit the same signed XDR under a different Idempotency-Key', async () => {
    const first = await postDisburse('disburse-key-a');
    expect(first.status).toBe(200);
    expect(mockSubmitSignedTx).toHaveBeenCalledTimes(1);

    const second = await postDisburse('disburse-key-b');
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(second.headers['x-idempotent-replayed']).toBe('true');
    expect(mockSubmitSignedTx).toHaveBeenCalledTimes(1);
    expect(mockPollTransactionByHash).toHaveBeenCalledWith(computeHash(SIGNED_XDR));
    expect(submissions).toHaveLength(1);
  });

  it('returns the original success response on tx_already_applied instead of a 500', async () => {
    const alreadyApplied = Object.assign(new Error('tx_already_applied'), {
      code: 'tx_already_applied',
    });
    mockSubmitSignedTx.mockRejectedValueOnce(alreadyApplied);

    const response = await postDisburse('disburse-key-3');

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.txHash).toBe(computeHash(SIGNED_XDR));
    expect(response.headers['x-idempotent-replayed']).toBe('true');
    expect(submissions[0].status).toBe('SUCCESS');
  });

  it('requires an Idempotency-Key for disbursement', async () => {
    const response = await request(app)
      .post('/api/admin/loans/42/disburse')
      .set(adminBearer())
      .send(payload);

    expect(response.status).toBe(400);
    expect(mockSubmitSignedTx).not.toHaveBeenCalled();
  });
});
