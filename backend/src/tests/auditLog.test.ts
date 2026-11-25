import { jest } from '@jest/globals';

import express from 'express';
import request from 'supertest';
import type { Request, Response, NextFunction } from 'express';

process.env.AUDIT_LOG_KEY = 'test-audit-log-key-0123456789abcdefghijklmnop';

/**
 * In-memory stand-in for the audit_logs table. It understands exactly the SQL
 * auditLogService issues, so the chain is exercised end-to-end through the
 * real append / iterate / verify code paths.
 */
type Row = {
  id: number;
  actor: string;
  action: string;
  target: string | null;
  payload: unknown;
  ip_address: string | null;
  status: number | null;
  created_at: Date;
  prev_hmac: string | null;
  hmac: string | null;
};
const table: Row[] = [];
let nextId = 1;

async function fakeQuery(sql: string, params: unknown[] = []) {
  if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
  if (sql.includes('SELECT hmac FROM audit_logs') && sql.includes('MIN(id)')) {
    const from = new Date(params[0] as string).getTime();
    const firstInRange = table.find((r) => r.created_at.getTime() >= from)?.id ?? Infinity;
    const anchor = [...table].reverse().find((r) => r.hmac && r.id < firstInRange);
    return { rows: anchor ? [{ hmac: anchor.hmac }] : [] };
  }
  if (sql.includes('SELECT hmac FROM audit_logs')) {
    const last = [...table].reverse().find((r) => r.hmac);
    return { rows: last ? [{ hmac: last.hmac }] : [] };
  }
  if (sql.includes('INSERT INTO audit_logs')) {
    const [actor, action, target, payload, ip, status, createdAt, prev] = params as [
      string,
      string,
      string | null,
      string | null,
      string | null,
      number | null,
      Date,
      string,
    ];
    const id = nextId++;
    table.push({
      id,
      actor,
      action,
      target,
      payload: payload ? JSON.parse(payload) : null,
      ip_address: ip,
      status,
      created_at: new Date(createdAt),
      prev_hmac: prev,
      hmac: null,
    });
    return { rows: [{ id }] };
  }
  if (sql.startsWith('UPDATE audit_logs SET hmac')) {
    const row = table.find((r) => r.id === params[1]);
    if (row) row.hmac = params[0] as string;
    return { rows: [] };
  }
  if (sql.includes('FROM audit_logs WHERE id >')) {
    let i = 0;
    const afterId = params[i++] as number;
    const from = sql.includes('created_at >=')
      ? new Date(params[i++] as string).getTime()
      : -Infinity;
    const to = sql.includes('created_at <=') ? new Date(params[i++] as string).getTime() : Infinity;
    const limit = params[i] as number;
    const rows = table
      .filter(
        (r) => r.id > afterId && r.created_at.getTime() >= from && r.created_at.getTime() <= to,
      )
      .slice(0, limit)
      .map((r) => ({ ...r }));
    return { rows };
  }
  return { rows: [] };
}

const mockedQuery = jest.fn(fakeQuery);

jest.unstable_mockModule('../db/connection.js', () => ({
  query: mockedQuery,
  default: { query: mockedQuery },
  withTransaction: async (fn: (c: { query: typeof mockedQuery }) => unknown) =>
    fn({ query: mockedQuery }),
}));

const { auditLog } = await import('../middleware/auditLog.js');
const { appendAuditLog, verifyAuditRange, computeAuditHmac, getAuditLogKey, AUDIT_GENESIS_HMAC } =
  await import('../services/auditLogService.js');
const { exportAuditLogs, verifyAuditLogs } =
  await import('../controllers/auditLogExportController.js');

function insertCall() {
  const call = mockedQuery.mock.calls.find(([sql]) =>
    String(sql).includes('INSERT INTO audit_logs'),
  );
  if (!call) throw new Error('no audit insert');
  return call;
}

describe('Audit Log Middleware', () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: NextFunction;

  beforeEach(() => {
    req = {
      method: 'POST',
      path: '/admin/check-defaults',
      headers: {
        'x-api-key': 'test-api-key',
      },
      body: {
        loanIds: [1, 2, 3],
      },
      ip: '127.0.0.1',
      socket: {} as import('net').Socket,
      params: {},
    };
    res = {
      statusCode: 200,
      on: jest.fn((event: string, callback: () => void) => {
        if (event === 'finish') {
          setTimeout(callback, 0);
        }
        return res as Response;
      }),
    };
    next = jest.fn();
    jest.clearAllMocks();
    table.length = 0;
    nextId = 1;
  });

  it('should log admin action to audit_logs table', async () => {
    auditLog(req as Request, res as Response, next);

    expect(next).toHaveBeenCalled();

    // The query is called asynchronously (void ...), so we might need to wait a tick
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mockedQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO audit_logs'),
      expect.arrayContaining([
        'INTERNAL_API_KEY',
        'POST /admin/check-defaults',
        'LoanIDs:[1,2,3]',
        expect.stringContaining('"loanIds":[1,2,3]'),
        '127.0.0.1',
        200,
      ]),
    );
  });

  it('should redact sensitive fields in payload at any depth', async () => {
    req.body = {
      secret: 'sensitive-data',
      loanId: 123,
      tx: {
        signedTxXdr: 'nested-sensitive-data',
        details: {
          token: 'deep-secret',
          publicInfo: 'safe',
        },
      },
    };

    auditLog(req as Request, res as Response, next);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mockedQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO audit_logs'),
      expect.arrayContaining([
        expect.anything(),
        expect.anything(),
        'LoanID:123',
        expect.stringContaining('[REDACTED]'),
        expect.anything(),
        200,
      ]),
    );

    const callArgs = insertCall();
    const callPayload = callArgs?.[1]?.[3];

    if (typeof callPayload === 'string') {
      const parsedPayload = JSON.parse(callPayload);
      expect(parsedPayload.secret).toBe('[REDACTED]');
      expect(parsedPayload.loanId).toBe(123);
      expect(parsedPayload.tx.signedTxXdr).toBe('[REDACTED]');
      expect(parsedPayload.tx.details.token).toBe('[REDACTED]');
      expect(parsedPayload.tx.details.publicInfo).toBe('safe');
    } else {
      throw new Error('Payload was not recorded as a string');
    }
  });

  it('should identify actor from JWT if present', async () => {
    (req as unknown as { user: { publicKey: string; role: string } }).user = {
      publicKey: 'G-STUDENT-WALLET-ADDR',
      role: 'admin',
    };

    auditLog(req as Request, res as Response, next);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mockedQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO audit_logs'),
      expect.arrayContaining([
        'G-STUDENT-WALLET-ADDR',
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        200,
      ]),
    );
  });

  it('should capture a denied admin request', async () => {
    res.statusCode = 403; // Simulate a denied request

    auditLog(req as Request, res as Response, next);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mockedQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO audit_logs'),
      expect.arrayContaining([
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        403,
      ]),
    );
  });
});

describe('Audit log HMAC chain (#796)', () => {
  const app = express();
  app.use(express.json());
  app.get('/export', exportAuditLogs);
  app.post('/verify', verifyAuditLogs);

  beforeEach(() => {
    table.length = 0;
    nextId = 1;
    mockedQuery.mockClear();
  });

  async function seed(n: number) {
    for (let i = 0; i < n; i++) {
      await appendAuditLog({
        actor: `GADMIN${i}`,
        action: 'POST /admin/check-defaults',
        target: `LoanID:${i}`,
        payload: { i },
        status: 200,
      });
    }
  }

  it('chains every entry from the genesis hash with HMAC-SHA256', async () => {
    await seed(3);
    expect(table[0]!.prev_hmac).toBe(AUDIT_GENESIS_HMAC);
    expect(table[1]!.prev_hmac).toBe(table[0]!.hmac);
    expect(table[2]!.prev_hmac).toBe(table[1]!.hmac);
    const r = table[1]!;
    expect(r.hmac).toBe(
      computeAuditHmac(
        r.prev_hmac!,
        { id: r.id, actor: r.actor, action: r.action, resource: r.target, createdAt: r.created_at },
        getAuditLogKey(),
      ),
    );
  });

  it('verifies an untampered chain end-to-end', async () => {
    await seed(5);
    const res = await request(app).post('/verify').send({});
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'pass', valid: true, checked: 5 });
    expect(res.body.data.firstBrokenLink).toBeNull();
  });

  it('detects an edited entry and reports the first broken link', async () => {
    await seed(5);
    table[2]!.actor = 'GATTACKER';
    const res = await request(app).post('/verify').send({});
    expect(res.body.data.status).toBe('fail');
    expect(res.body.data.firstBrokenLink).toMatchObject({ id: 3, reason: 'hmac_mismatch' });
  });

  it('detects a deleted entry via the successor prev_hmac', async () => {
    await seed(5);
    table.splice(1, 1);
    const result = await verifyAuditRange({});
    expect(result.valid).toBe(false);
    expect(result.firstBrokenLink).toMatchObject({ id: 3, reason: 'prev_hmac_mismatch' });
  });

  it('detects a chain re-forged with a different key', async () => {
    await seed(2);
    const forged = computeAuditHmac(
      table[1]!.prev_hmac!,
      { id: 2, actor: 'GEVIL', action: 'x', resource: null, createdAt: table[1]!.created_at },
      'attacker-guess-key-attacker-guess-key',
    );
    Object.assign(table[1]!, { actor: 'GEVIL', action: 'x', target: null, hmac: forged });
    expect((await verifyAuditRange({})).firstBrokenLink?.id).toBe(2);
  });

  it('verifies a sub-range anchored on the preceding entry', async () => {
    await seed(4);
    table.forEach((r, i) => (r.created_at = new Date(Date.UTC(2026, 0, i + 1))));
    // Recompute the chain with the adjusted timestamps.
    let prev = AUDIT_GENESIS_HMAC;
    for (const r of table) {
      r.prev_hmac = prev;
      r.hmac = computeAuditHmac(
        prev,
        { id: r.id, actor: r.actor, action: r.action, resource: r.target, createdAt: r.created_at },
        getAuditLogKey(),
      );
      prev = r.hmac;
    }
    const res = await request(app)
      .post('/verify')
      .send({ from: '2026-01-03T00:00:00.000Z', to: '2026-01-04T00:00:00.000Z' });
    expect(res.body.data).toMatchObject({ valid: true, checked: 2 });
  });

  it('streams the range as NDJSON with chain fields', async () => {
    await seed(3);
    const res = await request(app)
      .get('/export')
      .buffer(true)
      .parse((r, cb) => {
        let data = '';
        r.on('data', (c: Buffer) => (data += c.toString()));
        r.on('end', () => cb(null, data));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/x-ndjson');
    const lines = (res.body as string)
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ id: 1, prevHmac: AUDIT_GENESIS_HMAC, hmac: table[0]!.hmac });
    expect(lines[2].prevHmac).toBe(lines[1].hmac);
  });

  it('rejects malformed range bounds', async () => {
    const res = await request(app).get('/export?from=not-a-date');
    expect(res.status).toBe(400);
  });

  it('refuses an AUDIT_LOG_KEY equal to JWT_SECRET or missing in production', () => {
    const k = 'x'.repeat(40);
    expect(() => getAuditLogKey({ AUDIT_LOG_KEY: k, JWT_SECRET: k } as NodeJS.ProcessEnv)).toThrow(
      /differ/,
    );
    expect(() => getAuditLogKey({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toThrow(
      /required/,
    );
  });
});
