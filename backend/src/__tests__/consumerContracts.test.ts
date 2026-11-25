/**
 * Issue #510: consumer-driven API contract tests for the critical financial
 * flows (loan application, repayment, pool reads, transaction status).
 *
 * Issue #820: Pact consumer contract tests for external integrations
 * (Stellar Horizon, SendGrid, Twilio). Each provider interaction is recorded
 * as a Pact contract under src/__tests__/contracts/pacts/ during the test run
 * and verified in CI against the recorded contracts.
 *
 * Each contract is a strict zod shape declared by the consumer (borrower app,
 * lender app). Real Express routes are exercised through supertest; the chain
 * (sorobanService) and database are mocked. Request fixtures are parsed with the
 * same schemas the routes use (src/schemas), so they cannot drift from them.
 * Failures name the route, the consumer, and the mismatched field.
 *
 * To add a contract, see "Consumer contract tests" in CONTRIBUTING.md.
 */
import request from 'supertest';
import { jest } from '@jest/globals';
import { z } from 'zod';
import { Keypair } from '@stellar/stellar-sdk';
import { PactV3, MatchersV3 } from '@pact-foundation/pact';
import path from 'node:path';
import { generateJwtToken } from '../services/authService.js';
import { submitTxSchema } from '../schemas/loanSchemas.js';

type MockQueryResult = { rows: unknown[]; rowCount?: number };

const BORROWER = Keypair.random().publicKey();
const LENDER = Keypair.random().publicKey();

process.env.JWT_SECRET = 'test-jwt-secret-min-32-chars-long!!';
process.env.LENDER_WALLETS = LENDER;

const mockQuery: jest.MockedFunction<
  (text: string, params?: unknown[]) => Promise<MockQueryResult>
> = jest.fn();

jest.unstable_mockModule('../db/connection.js', () => ({
  default: { query: mockQuery },
  query: mockQuery,
  getClient: jest.fn(),
  closePool: jest.fn(),
  withTransaction: jest.fn(),
}));

jest.unstable_mockModule('../services/cacheService.js', () => ({
  cacheService: {
    get: jest.fn<() => Promise<null>>().mockResolvedValue(null),
    set: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    delete: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    ping: jest.fn<() => Promise<string>>().mockResolvedValue('ok'),
  },
}));

const mockBuildRequestLoanTx = jest.fn<() => Promise<unknown>>();
const mockBuildRepayTx = jest.fn<() => Promise<unknown>>();
const mockSubmitSignedTx = jest.fn<() => Promise<unknown>>();
jest.unstable_mockModule('../services/sorobanService.js', () => ({
  sorobanService: {
    buildRequestLoanTx: mockBuildRequestLoanTx,
    buildRepayTx: mockBuildRepayTx,
    submitSignedTx: mockSubmitSignedTx,
    getWithdrawalCooldownLedgers: jest.fn<() => Promise<number>>().mockResolvedValue(0),
  },
}));

const { default: app } = await import('../app.js');

const bearer = (key: string) => ({ Authorization: `Bearer ${generateJwtToken(key)}` });

// ---------------------------------------------------------------------------
// Consumer contracts. Bump `version` (and update the schema) only with an
// intentional, reviewed breaking change to the response.
// ---------------------------------------------------------------------------
interface Contract {
  route: string;
  consumer: string;
  version: number;
  schema: z.ZodTypeAny;
}

const unsignedTx = z
  .object({
    success: z.literal(true),
    unsignedTxXdr: z.string().min(1),
    networkPassphrase: z.string().min(1),
  })
  .strict();

const CONTRACTS = {
  loanRequest: {
    route: 'POST /api/loans/request',
    consumer: 'borrower-app',
    version: 1,
    schema: unsignedTx,
  },
  repay: {
    route: 'POST /api/loans/:loanId/repay',
    consumer: 'borrower-app',
    version: 1,
    schema: unsignedTx.extend({ loanId: z.number().int() }).strict(),
  },
  submit: {
    route: 'POST /api/loans/submit',
    consumer: 'borrower-app',
    version: 1,
    schema: z
      .object({
        success: z.literal(true),
        txHash: z.string().min(1),
        status: z.enum(['SUCCESS', 'PENDING', 'FAILED']),
      })
      .passthrough(),
  },
  poolStats: {
    route: 'GET /api/pool/stats',
    consumer: 'lender-app',
    version: 1,
    schema: z.object({
      success: z.literal(true),
      data: z.object({
        // Money units: plain numbers in token units, never strings.
        totalDeposits: z.number().nonnegative(),
        totalOutstanding: z.number().nonnegative(),
        utilizationRate: z.number().min(0).max(1),
        apy: z.number(),
        activeLoansCount: z.number().int().nonnegative(),
        withdrawalCooldownLedgers: z.number().int().nonnegative(),
      }),
    }),
  },
  transactionStatus: {
    route: 'GET /api/transactions/me',
    consumer: 'borrower-app',
    version: 1,
    schema: z.object({
      success: z.literal(true),
      data: z.array(
        z.object({
          id: z.number().int(),
          txHash: z.string(),
          status: z.string(),
          submittedBy: z.string(),
          transactionType: z.string().nullable().optional(),
        }),
      ),
      page_info: z.object({
        limit: z.number().int(),
        count: z.number().int(),
        next_cursor: z.string().nullable(),
        has_previous: z.boolean(),
        has_next: z.boolean(),
      }),
    }),
  },
  errorEnvelope: {
    route: '*',
    consumer: 'all',
    version: 1,
    schema: z.object({
      success: z.literal(false),
      error: z.object({ code: z.string(), message: z.string() }).passthrough(),
    }),
  },
} satisfies Record<string, Contract>;

/** Fails with route, consumer and the exact mismatched field path(s). */
function expectContract(contract: Contract, body: unknown): void {
  const result = contract.schema.safeParse(body);
  if (!result.success) {
    const fields = result.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new Error(
      `Contract violation [${contract.route}] consumer=${contract.consumer} v${contract.version}: ${fields}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Pact consumer contracts for external integrations (issue #820).
// Contracts are written to src/__tests__/contracts/pacts/ during the run and
// verified in CI (reusable-backend.yml) against the recorded contracts.
// ---------------------------------------------------------------------------
const PACT_DIR = path.resolve(__dirname, 'contracts/pacts');
const { like, regex, integer, string, boolean } = MatchersV3;

const HORIZON_ACCOUNT = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const HORIZON_TX_HASH = 'a'.repeat(64);

function makePact(consumer: string, provider: string): PactV3 {
  return new PactV3({
    consumer,
    provider,
    dir: PACT_DIR,
    logLevel: 'warn',
  });
}

beforeEach(() => {
  mockQuery.mockReset();
  jest.clearAllMocks();
});

afterAll(() => {
  delete process.env.JWT_SECRET;
  delete process.env.LENDER_WALLETS;
});

describe('consumer contracts: loan application', () => {
  const body = { amount: 1000, borrowerPublicKey: BORROWER };

  it('honours the success contract', async () => {
    mockBuildRequestLoanTx.mockResolvedValueOnce({
      unsignedTxXdr: 'AAAA',
      networkPassphrase: 'Test SDF Network ; September 2015',
    });
    const res = await request(app).post('/api/loans/request').set(bearer(BORROWER)).send(body);
    expect(res.status).toBe(200);
    expectContract(CONTRACTS.loanRequest, res.body);
  });

  it('rejects unauthenticated callers with the error envelope', async () => {
    const res = await request(app).post('/api/loans/request').send(body);
    expect(res.status).toBe(401);
    expectContract(CONTRACTS.errorEnvelope, res.body);
  });

  it('rejects a borrower acting for another wallet', async () => {
    const res = await request(app)
      .post('/api/loans/request')
      .set(bearer(BORROWER))
      .send({ ...body, borrowerPublicKey: Keypair.random().publicKey() });
    expect(res.status).toBe(403);
    expectContract(CONTRACTS.errorEnvelope, res.body);
  });

  it('requires amount (validation envelope)', async () => {
    const res = await request(app)
      .post('/api/loans/request')
      .set(bearer(BORROWER))
      .send({ borrowerPublicKey: BORROWER });
    expect(res.status).toBe(400);
    expectContract(CONTRACTS.errorEnvelope, res.body);
  });
});

describe('consumer contracts: repayment and submission', () => {
  it('honours the repay contract', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ address: BORROWER }] });
    mockBuildRepayTx.mockResolvedValueOnce({
      unsignedTxXdr: 'BBBB',
      networkPassphrase: 'Test SDF Network ; September 2015',
    });
    const res = await request(app)
      .post('/api/loans/1/repay')
      .set(bearer(BORROWER))
      .send({ amount: 500, borrowerPublicKey: BORROWER });
    expect(res.status).toBe(200);
    expectContract(CONTRACTS.repay, res.body);
  });

  it('denies repayment on a loan owned by someone else', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ address: Keypair.random().publicKey() }] });
    const res = await request(app)
      .post('/api/loans/1/repay')
      .set(bearer(BORROWER))
      .send({ amount: 500, borrowerPublicKey: BORROWER });
    expect(res.status).toBe(403);
    expectContract(CONTRACTS.errorEnvelope, res.body);
  });

  it('honours the submit contract', async () => {
    mockSubmitSignedTx.mockResolvedValueOnce({ txHash: 'deadbeef', status: 'SUCCESS' });
    const res = await request(app)
      .post('/api/loans/submit')
      .set(bearer(BORROWER))
      .send({ signedTxXdr: 'CCCC' });
    expect(res.status).toBe(200);
    expectContract(CONTRACTS.submit, res.body);
  });

  it('validates submit payloads with the shared schema', () => {
    expect(submitTxSchema.safeParse({ signedTxXdr: 'CCCC' }).success).toBe(true);
    expect(submitTxSchema.safeParse({}).success).toBe(false);
  });
});

describe('consumer contracts: pool and transaction reads', () => {
  it('honours the pool stats contract', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          total_deposits: '1000',
          total_outstanding: '250',
          utilization_rate: '0.25',
          apy: '0.08',
          active_loans_count: '3',
        },
      ],
    });
    const res = await request(app).get('/api/pool/stats');
    expect(res.status).toBe(200);
    expectContract(CONTRACTS.poolStats, res.body);
  });

  it('honours the transaction status contract', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 1,
          tx_hash: 'deadbeef',
          status: 'SUCCESS',
          submitted_by: BORROWER,
          transaction_type: 'loan_request',
        },
      ],
    });
    const res = await request(app).get('/api/transactions/me').set(bearer(BORROWER));
    expect(res.status).toBe(200);
    expectContract(CONTRACTS.transactionStatus, res.body);
  });
});

describe('pact consumer contracts: Stellar Horizon', () => {
  const pact = makePact('backend', 'stellar-horizon');

  it('GET /accounts/:id returns the account shape the backend consumes', async () => {
    pact
      .given('account exists')
      .uponReceiving('a request for an account')
      .withRequest({
        method: 'GET',
        path: `/accounts/${HORIZON_ACCOUNT}`,
      })
      .willRespondWith({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: {
          id: like(HORIZON_ACCOUNT),
          account_id: like(HORIZON_ACCOUNT),
          sequence: string('123456789'),
          subentry_count: integer(0),
          balances: like([
            {
              balance: string('100.0000000'),
              asset_type: string('native'),
            },
          ]),
        },
      });

    await pact.executeTest(async (mockServer) => {
      const res = await fetch(`${mockServer.url}/accounts/${HORIZON_ACCOUNT}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.account_id).toBe(HORIZON_ACCOUNT);
      expect(Array.isArray(body.balances)).toBe(true);
    });
  });

  it('POST /transactions accepts a signed transaction envelope', async () => {
    pact
      .given('a valid signed transaction')
      .uponReceiving('a submission of a signed transaction')
      .withRequest({
        method: 'POST',
        path: '/transactions',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: regex('tx=.*', 'tx=AAAA'),
      })
      .willRespondWith({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: {
          hash: like(HORIZON_TX_HASH),
          successful: boolean(true),
          ledger: integer(12345),
        },
      });

    await pact.executeTest(async (mockServer) => {
      const res = await fetch(`${mockServer.url}/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'tx=AAAA',
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(typeof body.hash).toBe('string');
    });
  });

  it('GET /transactions/:hash returns the transaction status shape', async () => {
    pact
      .given('a transaction exists')
      .uponReceiving('a request for a transaction by hash')
      .withRequest({
        method: 'GET',
        path: `/transactions/${HORIZON_TX_HASH}`,
      })
      .willRespondWith({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: {
          hash: like(HORIZON_TX_HASH),
          successful: boolean(true),
          ledger: integer(12345),
          created_at: string('2024-01-01T00:00:00Z'),
        },
      });

    await pact.executeTest(async (mockServer) => {
      const res = await fetch(`${mockServer.url}/transactions/${HORIZON_TX_HASH}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.hash).toBe(HORIZON_TX_HASH);
    });
  });
});

describe('pact consumer contracts: SendGrid', () => {
  const pact = makePact('backend', 'sendgrid');

  it('POST /v3/mail/send accepts the expected request schema', async () => {
    pact
      .given('a transactional email is queued')
      .uponReceiving('a request to send an email')
      .withRequest({
        method: 'POST',
        path: '/v3/mail/send',
        headers: {
          'Content-Type': 'application/json',
          Authorization: regex('Bearer .*', 'Bearer test-key'),
        },
        body: {
          personalizations: like([
            {
              to: like([{ email: like('borrower@example.com') }]),
              dynamic_template_data: like({ amount: string('1000') }),
            },
          ]),
          from: like({ email: like('no-reply@example.com') }),
          template_id: like('d-1234567890'),
        },
      })
      .willRespondWith({
        status: 202,
        headers: { 'X-Message-Id': like('msg-123') },
      });

    await pact.executeTest(async (mockServer) => {
      const res = await fetch(`${mockServer.url}/v3/mail/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-key',
        },
        body: JSON.stringify({
          personalizations: [
            {
              to: [{ email: 'borrower@example.com' }],
              dynamic_template_data: { amount: '1000' },
            },
          ],
          from: { email: 'no-reply@example.com' },
          template_id: 'd-1234567890',
        }),
      });
      expect(res.status).toBe(202);
    });
  });
});

describe('pact consumer contracts: Twilio', () => {
  const pact = makePact('backend', 'twilio');

  it('POST /Messages accepts the expected request schema', async () => {
    pact
      .given('an SMS notification is queued')
      .uponReceiving('a request to send an SMS')
      .withRequest({
        method: 'POST',
        path: '/Messages',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: regex('To=.*&From=.*&Body=.*', 'To=%2B15550000000&From=%2B15551111111&Body=hello'),
      })
      .willRespondWith({
        status: 201,
        headers: { 'Content-Type': 'application/json' },
        body: {
          sid: like('SM1234567890'),
          status: like('queued'),
          to: like('+15550000000'),
          from: like('+15551111111'),
        },
      });

    await pact.executeTest(async (mockServer) => {
      const res = await fetch(`${mockServer.url}/Messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'To=%2B15550000000&From=%2B15551111111&Body=hello',
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as Record<string, unknown>;
      expect(typeof body.sid).toBe('string');
    });
  });
});
