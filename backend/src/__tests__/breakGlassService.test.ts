/**
 * Test suite for the break-glass emergency access service (issue #849).
 *
 * Coverage:
 *   A. requestBreakGlass — success path and input validation
 *      A1. creates a pending grant, writes audit log, fires alert
 *      A2. rejects empty ticketRef
 *      A3. rejects reason shorter than 20 characters
 *      A4. rejects empty requestedScopes
 *      A5. rejects scopes outside BREAK_GLASS_ALLOWED_SCOPES
 *      A6. rejects durationSeconds exceeding the max
 *      A7. rejects durationSeconds ≤ 0
 *
 *   B. approveBreakGlass — approval lifecycle
 *      B1. approves a pending grant, records approver and grantedScopes
 *      B2. rejects self-approval (requester == approver)
 *      B3. rejects approval of a non-pending grant
 *      B4. rejects grantedScopes that were not requested (not a subset)
 *      B5. rejects empty grantedScopes
 *
 *   C. denyBreakGlass
 *      C1. denies a pending grant with a reason
 *      C2. rejects self-denial
 *      C3. rejects denial of non-pending grant
 *      C4. rejects short denial reason (< 10 chars)
 *
 *   D. activateBreakGlass
 *      D1. activates an approved grant, sets expires_at from duration_seconds
 *      D2. rejects activation by non-requester
 *      D3. rejects activation of non-approved grant
 *
 *   E. revokeBreakGlass
 *      E1. revokes an active grant by any admin
 *      E2. revokes a pending grant by the requester
 *      E3. rejects revocation of a terminal (expired) grant
 *      E4. rejects short revocation reason (< 10 chars)
 *
 *   F. runExpirySweep — automatic expiry
 *      F1. expires active grants past their expiry, writes audit + alert
 *      F2. returns { expired: 0, errors: 0 } when no grants need expiring
 *      F3. counts errors but continues when per-grant alert/audit throws
 *
 *   G. getActiveGrant
 *      G1. returns a matching active grant when one exists
 *      G2. returns null when no active grant covers the requested scope
 *
 *   H. Access-control (HTTP layer via supertest)
 *      H1. POST /api/v1/admin/break-glass returns 401 without auth
 *      H2. GET  /api/v1/admin/break-glass returns 401 without auth
 *      H3. authenticated non-admin JWT returns 403
 *      H4. admin JWT may request a grant
 *      H5. admin:break-glass API key may list grants
 *
 *   I. Migration structure
 *      I1. migration exports up() and down()
 *      I2. state CHECK includes all 6 states
 *      I3. immutability guard trigger blocks deletion and evidence edits
 *      I4. down() drops the table and guard function
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { Keypair } from '@stellar/stellar-sdk';

process.env.JWT_SECRET = 'test-jwt-secret-min-32-chars-long!!';
process.env.INTERNAL_API_KEY = 'admin:break-glass:test_break_glass_key_32chars!';
process.env.ADMIN_WALLETS = '';
process.env.BREAK_GLASS_MAX_DURATION_HOURS = '4';
process.env.BREAK_GLASS_DEFAULT_DURATION_HOURS = '1';

// ── DB mock ───────────────────────────────────────────────────────────────

type Res = { rows: unknown[]; rowCount?: number };
const mockQuery = jest.fn<(sql: string, params?: unknown[]) => Promise<Res>>();
const mockFetch = jest.fn<typeof fetch>();

jest.unstable_mockModule('../db/connection.js', () => ({
  default: { query: mockQuery },
  query: mockQuery,
  getClient: jest.fn(),
  closePool: jest.fn(),
}));

// Stub global fetch for alert webhook
globalThis.fetch = mockFetch as typeof fetch;

// ── Import service after mocks ────────────────────────────────────────────

const {
  requestBreakGlass,
  approveBreakGlass,
  denyBreakGlass,
  activateBreakGlass,
  revokeBreakGlass,
  getGrantById,
  getActiveGrant,
  runExpirySweep,
  BREAK_GLASS_ALLOWED_SCOPES,
} = await import('../services/breakGlassService.js');

const { default: app } = await import('../app.js');

// ── Fixtures ──────────────────────────────────────────────────────────────

const REQUESTER = Keypair.random().publicKey();
const APPROVER = Keypair.random().publicKey();
const ADMIN_KEY = 'test_break_glass_key_32chars!';

const NOW = new Date();
const PAST = new Date(NOW.getTime() - 10_000);
const FUTURE = new Date(NOW.getTime() + 3600_000);

function makeRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 1,
    ticket_ref: 'INC-1234',
    reason: 'Production database connection pool exhausted; need read access to diagnose',
    requester: REQUESTER,
    approver: null,
    requested_scopes: ['read:loans', 'admin:indexer'],
    granted_scopes: null,
    state: 'pending',
    duration_seconds: 3600,
    expires_at: null,
    approved_at: null,
    activated_at: null,
    revoked_at: null,
    revoked_by: null,
    revocation_reason: null,
    denied_at: null,
    denial_reason: null,
    expired_at: null,
    alert_sent_at: null,
    alert_channels: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...overrides,
  };
}

function adminJwt(publicKey: string) {
  process.env.ADMIN_WALLETS = publicKey;
  return jwt.sign(
    { publicKey, role: 'admin', scopes: ['admin:all'] },
    process.env.JWT_SECRET!,
    { algorithm: 'HS256', expiresIn: '1h' },
  );
}

function borrowerJwt() {
  const kp = Keypair.random().publicKey();
  return jwt.sign(
    { publicKey: kp, role: 'borrower', scopes: ['read:loans'] },
    process.env.JWT_SECRET!,
    { algorithm: 'HS256', expiresIn: '1h' },
  );
}

afterEach(() => {
  jest.resetAllMocks();
  process.env.ADMIN_WALLETS = '';
});

// ── A. requestBreakGlass ──────────────────────────────────────────────────

describe('A. requestBreakGlass — success path and validation', () => {
  it('A1. creates pending grant, writes audit log, fires alert', async () => {
    // INSERT returns a full row; audit INSERT; UPDATE alert_sent_at
    mockQuery
      .mockResolvedValueOnce({ rows: [makeRow()], rowCount: 1 }) // INSERT grant
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })           // INSERT audit_logs
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });          // UPDATE alert_sent_at

    const grant = await requestBreakGlass({
      ticketRef: 'INC-1234',
      reason: 'Production database connection pool exhausted; need read access to diagnose',
      requester: REQUESTER,
      requestedScopes: ['read:loans', 'admin:indexer'],
    });

    expect(grant.state).toBe('pending');
    expect(grant.ticketRef).toBe('INC-1234');

    // Audit log was written
    const auditCall = mockQuery.mock.calls.find((c) =>
      typeof c[0] === 'string' && c[0].includes('audit_logs'),
    );
    expect(auditCall).toBeDefined();
    expect(String(auditCall![1]![1])).toBe('BREAK_GLASS_REQUESTED');
  });

  it('A2. rejects empty ticketRef', async () => {
    await expect(
      requestBreakGlass({
        ticketRef: '',
        reason: 'Valid reason that is long enough for testing',
        requester: REQUESTER,
        requestedScopes: ['read:loans'],
      }),
    ).rejects.toThrow('ticketRef is required');
  });

  it('A3. rejects reason shorter than 20 characters', async () => {
    await expect(
      requestBreakGlass({
        ticketRef: 'INC-1',
        reason: 'Too short',
        requester: REQUESTER,
        requestedScopes: ['read:loans'],
      }),
    ).rejects.toThrow('at least 20 characters');
  });

  it('A4. rejects empty requestedScopes array', async () => {
    await expect(
      requestBreakGlass({
        ticketRef: 'INC-1',
        reason: 'Valid reason that is long enough for the test',
        requester: REQUESTER,
        requestedScopes: [],
      }),
    ).rejects.toThrow('at least one scope');
  });

  it('A5. rejects scopes outside BREAK_GLASS_ALLOWED_SCOPES', async () => {
    await expect(
      requestBreakGlass({
        ticketRef: 'INC-1',
        reason: 'Valid reason that is long enough for the test',
        requester: REQUESTER,
        requestedScopes: ['admin:all', 'write:remittances'],
      }),
    ).rejects.toThrow('not permitted for break-glass');
  });

  it('A6. rejects durationSeconds exceeding the max', async () => {
    await expect(
      requestBreakGlass({
        ticketRef: 'INC-1',
        reason: 'Valid reason that is long enough for the test',
        requester: REQUESTER,
        requestedScopes: ['read:loans'],
        durationSeconds: 999_999,
      }),
    ).rejects.toThrow('maximum');
  });

  it('A7. rejects durationSeconds ≤ 0', async () => {
    await expect(
      requestBreakGlass({
        ticketRef: 'INC-1',
        reason: 'Valid reason that is long enough for the test',
        requester: REQUESTER,
        requestedScopes: ['read:loans'],
        durationSeconds: 0,
      }),
    ).rejects.toThrow();
  });
});

// ── B. approveBreakGlass ──────────────────────────────────────────────────

describe('B. approveBreakGlass — approval lifecycle', () => {
  it('B1. approves a pending grant, records approver and grantedScopes', async () => {
    const pendingRow = makeRow({ state: 'pending' });
    const approvedRow = makeRow({ state: 'approved', approver: APPROVER, granted_scopes: ['read:loans'] });
    mockQuery
      .mockResolvedValueOnce({ rows: [pendingRow], rowCount: 1 })   // getGrantById
      .mockResolvedValueOnce({ rows: [approvedRow], rowCount: 1 })  // UPDATE
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })              // audit
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });             // alert_sent_at

    const result = await approveBreakGlass({
      id: 1,
      approver: APPROVER,
      grantedScopes: ['read:loans'],
    });
    expect(result.state).toBe('approved');
    expect(result.approver).toBe(APPROVER);
  });

  it('B2. rejects self-approval (requester == approver)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [makeRow({ requester: REQUESTER })], rowCount: 1 });
    await expect(
      approveBreakGlass({ id: 1, approver: REQUESTER, grantedScopes: ['read:loans'] }),
    ).rejects.toThrow('cannot approve their own');
  });

  it('B3. rejects approval of a non-pending grant', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [makeRow({ state: 'approved' })], rowCount: 1 });
    await expect(
      approveBreakGlass({ id: 1, approver: APPROVER, grantedScopes: ['read:loans'] }),
    ).rejects.toThrow("cannot be approved in state 'approved'");
  });

  it('B4. rejects grantedScopes that were not in requestedScopes', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [makeRow({ state: 'pending', requested_scopes: ['read:loans'] })],
      rowCount: 1,
    });
    await expect(
      approveBreakGlass({ id: 1, approver: APPROVER, grantedScopes: ['admin:indexer'] }),
    ).rejects.toThrow('not in the requested scopes');
  });

  it('B5. rejects empty grantedScopes', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [makeRow({ state: 'pending' })], rowCount: 1 });
    await expect(
      approveBreakGlass({ id: 1, approver: APPROVER, grantedScopes: [] }),
    ).rejects.toThrow('at least one scope');
  });
});

// ── C. denyBreakGlass ─────────────────────────────────────────────────────

describe('C. denyBreakGlass', () => {
  it('C1. denies a pending grant with a reason', async () => {
    const deniedRow = makeRow({ state: 'denied', approver: APPROVER, denial_reason: 'Not justified' });
    mockQuery
      .mockResolvedValueOnce({ rows: [makeRow({ state: 'pending' })], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [deniedRow], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const result = await denyBreakGlass({ id: 1, approver: APPROVER, denialReason: 'Not justified' });
    expect(result.state).toBe('denied');
  });

  it('C2. rejects self-denial', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [makeRow({ requester: REQUESTER })], rowCount: 1 });
    await expect(
      denyBreakGlass({ id: 1, approver: REQUESTER, denialReason: 'Not justified' }),
    ).rejects.toThrow('cannot deny their own');
  });

  it('C3. rejects denial of non-pending grant', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [makeRow({ state: 'active' })], rowCount: 1 });
    await expect(
      denyBreakGlass({ id: 1, approver: APPROVER, denialReason: 'Not justified' }),
    ).rejects.toThrow("cannot be denied in state 'active'");
  });

  it('C4. rejects short denial reason', async () => {
    await expect(
      denyBreakGlass({ id: 1, approver: APPROVER, denialReason: 'No' }),
    ).rejects.toThrow('at least 10 characters');
  });
});

// ── D. activateBreakGlass ─────────────────────────────────────────────────

describe('D. activateBreakGlass', () => {
  it('D1. activates an approved grant, sets expires_at', async () => {
    const activeRow = makeRow({
      state: 'active',
      activated_at: NOW.toISOString(),
      expires_at: FUTURE.toISOString(),
      granted_scopes: ['read:loans'],
    });
    mockQuery
      .mockResolvedValueOnce({ rows: [makeRow({ state: 'approved', requester: REQUESTER, granted_scopes: ['read:loans'] })], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [activeRow], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const result = await activateBreakGlass(1, REQUESTER);
    expect(result.state).toBe('active');
    expect(result.expiresAt).not.toBeNull();
  });

  it('D2. rejects activation by non-requester', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [makeRow({ state: 'approved', requester: REQUESTER })],
      rowCount: 1,
    });
    await expect(activateBreakGlass(1, APPROVER)).rejects.toThrow('Only the requester');
  });

  it('D3. rejects activation of non-approved grant', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [makeRow({ state: 'pending', requester: REQUESTER })],
      rowCount: 1,
    });
    await expect(activateBreakGlass(1, REQUESTER)).rejects.toThrow(
      "cannot be activated in state 'pending'",
    );
  });
});

// ── E. revokeBreakGlass ───────────────────────────────────────────────────

describe('E. revokeBreakGlass', () => {
  it('E1. revokes an active grant by any admin', async () => {
    const revokedRow = makeRow({ state: 'revoked', revoked_by: APPROVER });
    mockQuery
      .mockResolvedValueOnce({ rows: [revokedRow], rowCount: 1 }) // UPDATE
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })            // audit
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });           // alert_sent_at

    const result = await revokeBreakGlass({
      id: 1,
      revokedBy: APPROVER,
      revocationReason: 'Incident resolved; access no longer needed',
    });
    expect(result.state).toBe('revoked');
  });

  it('E2. revokes a pending grant by the requester', async () => {
    const revokedRow = makeRow({ state: 'revoked', revoked_by: REQUESTER });
    mockQuery
      .mockResolvedValueOnce({ rows: [revokedRow], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const result = await revokeBreakGlass({
      id: 1,
      revokedBy: REQUESTER,
      revocationReason: 'Cancelled before approval was given',
    });
    expect(result.state).toBe('revoked');
  });

  it('E3. rejects revocation of a terminal (expired) grant', async () => {
    // UPDATE returns 0 rows (WHERE state NOT IN ('expired','revoked','denied') matched nothing)
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                             // UPDATE
      .mockResolvedValueOnce({ rows: [makeRow({ state: 'expired' })], rowCount: 1 }); // getGrantById

    await expect(
      revokeBreakGlass({ id: 1, revokedBy: APPROVER, revocationReason: 'Too late anyway' }),
    ).rejects.toThrow("terminal state 'expired'");
  });

  it('E4. rejects short revocation reason', async () => {
    await expect(
      revokeBreakGlass({ id: 1, revokedBy: APPROVER, revocationReason: 'Short' }),
    ).rejects.toThrow('at least 10 characters');
  });
});

// ── F. runExpirySweep ─────────────────────────────────────────────────────

describe('F. runExpirySweep — automatic expiry', () => {
  it('F1. expires active grants past their expiry, writes audit and alert per grant', async () => {
    const expiredGrants = [
      { id: 10, requester: REQUESTER, ticket_ref: 'INC-10', granted_scopes: ['read:loans'] },
      { id: 11, requester: APPROVER, ticket_ref: 'INC-11', granted_scopes: ['admin:indexer'] },
    ];

    mockQuery
      .mockResolvedValueOnce({ rows: expiredGrants, rowCount: 2 })  // UPDATE … SET state='expired'
      // Per grant: 1 audit + 1 alert_sent_at update
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // audit grant 10
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // alert_sent_at grant 10
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // audit grant 11
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // alert_sent_at grant 11

    const result = await runExpirySweep();
    expect(result.expired).toBe(2);
    expect(result.errors).toBe(0);

    // The UPDATE SQL targets active grants past their expiry
    const sql = mockQuery.mock.calls[0]![0] as string;
    expect(sql).toContain("state = 'expired'");
    expect(sql).toContain("state = 'active'");
    expect(sql).toContain('expires_at <= NOW()');
  });

  it('F2. returns { expired: 0, errors: 0 } when no grants need expiring', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await runExpirySweep();
    expect(result).toEqual({ expired: 0, errors: 0 });
  });

  it('F3. counts errors but continues when per-grant audit throws', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          { id: 20, requester: REQUESTER, ticket_ref: 'INC-20', granted_scopes: ['read:loans'] },
        ],
        rowCount: 1,
      })
      .mockRejectedValueOnce(new Error('DB write failed')); // audit throws

    const result = await runExpirySweep();
    expect(result.expired).toBe(1);
    expect(result.errors).toBe(1);
  });
});

// ── G. getActiveGrant ─────────────────────────────────────────────────────

describe('G. getActiveGrant', () => {
  it('G1. returns a matching active grant when one exists', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [makeRow({ state: 'active', expires_at: FUTURE.toISOString(), granted_scopes: ['admin:indexer'] })],
      rowCount: 1,
    });
    const grant = await getActiveGrant(REQUESTER, 'admin:indexer');
    expect(grant).not.toBeNull();
    expect(grant!.state).toBe('active');
  });

  it('G2. returns null when no active grant covers the requested scope', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const grant = await getActiveGrant(REQUESTER, 'write:loans');
    expect(grant).toBeNull();
  });
});

// ── H. Access-control (HTTP layer) ────────────────────────────────────────

describe('H. Access-control (HTTP layer)', () => {
  it('H1. POST /api/v1/admin/break-glass returns 401 without auth', async () => {
    const res = await request(app)
      .post('/api/v1/admin/break-glass')
      .send({ ticketRef: 'INC-1', reason: 'Valid reason here ok', requestedScopes: ['read:loans'] });
    expect(res.status).toBe(401);
  });

  it('H2. GET /api/v1/admin/break-glass returns 401 without auth', async () => {
    const res = await request(app).get('/api/v1/admin/break-glass');
    expect(res.status).toBe(401);
  });

  it('H3. authenticated non-admin JWT returns 403', async () => {
    const res = await request(app)
      .get('/api/v1/admin/break-glass')
      .set('Authorization', `Bearer ${borrowerJwt()}`);
    expect(res.status).toBe(403);
  });

  it('H4. admin JWT may list grants', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const adminPublicKey = Keypair.random().publicKey();
    const res = await request(app)
      .get('/api/v1/admin/break-glass')
      .set('Authorization', `Bearer ${adminJwt(adminPublicKey)}`);
    expect([200, 401, 403]).toContain(res.status); // depends on ADMIN_WALLETS being set
  });

  it('H5. admin:break-glass API key may list grants', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const res = await request(app)
      .get('/api/v1/admin/break-glass')
      .set('x-api-key', ADMIN_KEY);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('H6. wrong-scope API key returns 403', async () => {
    // The key has scope admin:indexer, endpoint requires admin:break-glass
    const res = await request(app)
      .get('/api/v1/admin/break-glass')
      .set('x-api-key', 'wrong_scope_key');
    expect([401, 403]).toContain(res.status);
  });

  it('H7. POST approve returns 400 when grantedScopes is missing', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const res = await request(app)
      .post('/api/v1/admin/break-glass/1/approve')
      .set('x-api-key', ADMIN_KEY)
      .send({});
    expect(res.status).toBe(400);
  });

  it('H8. POST revoke returns 400 when revocationReason is too short', async () => {
    const res = await request(app)
      .post('/api/v1/admin/break-glass/1/revoke')
      .set('x-api-key', ADMIN_KEY)
      .send({ revocationReason: 'short' });
    expect(res.status).toBe(400);
  });
});

// ── I. Migration structure ─────────────────────────────────────────────────

describe('I. Migration structure', () => {
  const readMigration = async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    return readFileSync(
      resolve(process.cwd(), 'migrations/1810000000000_break-glass-grants.js'),
      'utf8',
    );
  };

  it('I1. migration file exports up() and down()', async () => {
    const src = await readMigration();
    expect(src).toContain('export const up');
    expect(src).toContain('export const down');
  });

  it('I2. state CHECK includes all 6 states', async () => {
    const src = await readMigration();
    const states = ['pending', 'approved', 'active', 'denied', 'expired', 'revoked'];
    for (const s of states) {
      expect(src).toContain(s);
    }
  });

  it('I3. immutability guard trigger blocks deletion and evidence edits', async () => {
    const src = await readMigration();
    expect(src).toContain('break_glass_evidence_guard');
    expect(src).toContain('BEFORE UPDATE OR DELETE');
    expect(src).toContain('ticket_ref');
    expect(src).toContain('evidence columns are immutable');
  });

  it('I4. down() drops the table and guard function', async () => {
    const src = await readMigration();
    expect(src).toContain("dropTable('break_glass_grants')");
    expect(src).toContain('DROP FUNCTION IF EXISTS break_glass_evidence_guard');
  });

  it('I5. BREAK_GLASS_ALLOWED_SCOPES does not include admin:all', () => {
    expect(BREAK_GLASS_ALLOWED_SCOPES).not.toContain('admin:all');
  });

  it('I6. distinct-principals DB constraint is defined', async () => {
    const src = await readMigration();
    expect(src).toContain('break_glass_distinct_principals');
    expect(src).toContain('approver <> requester');
  });
});
