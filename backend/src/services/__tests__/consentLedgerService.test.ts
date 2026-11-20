/**
 * Tests for consentLedgerService (#845).
 *
 * Coverage:
 *  - grantConsent: happy path, idempotency (duplicate key), validation guards
 *  - revokeConsent: happy path, missing consent (404), already revoked (409),
 *    duplicate idempotency key
 *  - listConsentHistory: empty, filtered by purpose, keyset cursor, limit cap
 *  - getEffectiveConsents: maps the consent_effective view rows correctly
 *  - isConsentGranted: granted, revoked, expired, missing, version comparison
 *  - Input validation: unsupported purpose, unknown data category, bad policy_version format
 *  - Downstream-job enforcement: isConsentGranted returns false for stale policy version
 */

import { jest, describe, it, expect, beforeAll, beforeEach } from '@jest/globals';

// ---------------------------------------------------------------------------
// Mock setup (must come before dynamic import)
// ---------------------------------------------------------------------------

type Res = { rows: unknown[]; rowCount?: number };
const mockQuery = jest.fn<(sql: string, params?: unknown[]) => Promise<Res>>();

let grantConsent: typeof import('../consentLedgerService.js').grantConsent;
let revokeConsent: typeof import('../consentLedgerService.js').revokeConsent;
let listConsentHistory: typeof import('../consentLedgerService.js').listConsentHistory;
let getEffectiveConsents: typeof import('../consentLedgerService.js').getEffectiveConsents;
let isConsentGranted: typeof import('../consentLedgerService.js').isConsentGranted;
let CONSENT_PURPOSES: typeof import('../consentLedgerService.js').CONSENT_PURPOSES;
let CONSENT_DATA_CATEGORIES: typeof import('../consentLedgerService.js').CONSENT_DATA_CATEGORIES;

beforeAll(async () => {
  jest.unstable_mockModule('../../db/connection.js', () => ({
    default: { query: mockQuery },
    query: mockQuery,
    getClient: jest.fn(),
    withTransaction: jest.fn(),
    TRANSIENT_ERROR_CODES: new Set(),
  }));

  jest.unstable_mockModule('../../utils/logger.js', () => ({
    default: {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    },
  }));

  const mod = await import('../consentLedgerService.js');
  grantConsent = mod.grantConsent;
  revokeConsent = mod.revokeConsent;
  listConsentHistory = mod.listConsentHistory;
  getEffectiveConsents = mod.getEffectiveConsents;
  isConsentGranted = mod.isConsentGranted;
  CONSENT_PURPOSES = mod.CONSENT_PURPOSES;
  CONSENT_DATA_CATEGORIES = mod.CONSENT_DATA_CATEGORIES;
});

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER = 'GADMIN00000000000000000000000000000000000000000000000000';

function makeConsentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'uuid-1',
    user_id: USER,
    purpose: 'credit_score_processing',
    status: 'granted',
    policy_version: '1.0',
    data_categories: ['credit_score', 'wallet_address'],
    revocation_reason: null,
    idempotency_key: 'idemp-abc',
    ip_address: '127.0.0.1',
    user_agent: 'Jest',
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// grantConsent
// ---------------------------------------------------------------------------

describe('grantConsent', () => {
  it('inserts a granted row and writes an audit entry', async () => {
    const row = makeConsentRow();
    mockQuery
      .mockResolvedValueOnce({ rows: [row], rowCount: 1 }) // INSERT
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });   // audit

    const result = await grantConsent({
      userId: USER,
      purpose: 'credit_score_processing',
      policyVersion: '1.0',
      dataCategories: ['credit_score', 'wallet_address'],
      idempotencyKey: 'idemp-abc',
      ipAddress: '127.0.0.1',
    });

    expect(result.id).toBe('uuid-1');
    expect(result.status).toBe('granted');
    expect(result.purpose).toBe('credit_score_processing');

    const insertSql = mockQuery.mock.calls[0]![0] as string;
    expect(insertSql).toContain('INSERT INTO consent_ledger');
    expect(insertSql).toContain("'granted'");

    const auditSql = mockQuery.mock.calls[1]![0] as string;
    expect(auditSql).toContain('audit_logs');
    expect(mockQuery.mock.calls[1]![1]![1]).toBe('CONSENT_GRANTED');
  });

  it('returns the existing record on duplicate idempotency key (idempotency)', async () => {
    const existing = makeConsentRow();
    const pgDup = Object.assign(new Error('duplicate key'), { code: '23505' });
    mockQuery
      .mockRejectedValueOnce(pgDup)                              // INSERT conflict
      .mockResolvedValueOnce({ rows: [existing], rowCount: 1 }); // SELECT existing

    const result = await grantConsent({
      userId: USER,
      purpose: 'credit_score_processing',
      policyVersion: '1.0',
      dataCategories: ['credit_score'],
      idempotencyKey: 'idemp-abc',
    });

    expect(result.id).toBe('uuid-1');
    expect(result.status).toBe('granted');
  });

  it('rejects an unsupported purpose', async () => {
    await expect(
      grantConsent({
        userId: USER,
        purpose: 'hack_the_planet' as never,
        policyVersion: '1.0',
        dataCategories: ['credit_score'],
        idempotencyKey: 'k1',
      }),
    ).rejects.toThrow('Unsupported consent purpose');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('rejects an unknown data category', async () => {
    await expect(
      grantConsent({
        userId: USER,
        purpose: 'credit_score_processing',
        policyVersion: '1.0',
        dataCategories: ['bank_account' as never],
        idempotencyKey: 'k2',
      }),
    ).rejects.toThrow('Unknown data category');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('rejects a malformed policy version', async () => {
    await expect(
      grantConsent({
        userId: USER,
        purpose: 'credit_score_processing',
        policyVersion: 'v1.0.0',
        dataCategories: ['credit_score'],
        idempotencyKey: 'k3',
      }),
    ).rejects.toThrow('policy_version must be in MAJOR.MINOR format');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('rejects an empty idempotency key', async () => {
    await expect(
      grantConsent({
        userId: USER,
        purpose: 'credit_score_processing',
        policyVersion: '1.0',
        dataCategories: ['credit_score'],
        idempotencyKey: '   ',
      }),
    ).rejects.toThrow('idempotency_key is required');
  });

  it('enumerates all supported purposes and categories', () => {
    expect(CONSENT_PURPOSES).toContain('credit_score_processing');
    expect(CONSENT_PURPOSES).toContain('marketing_communications');
    expect(CONSENT_DATA_CATEGORIES).toContain('credit_score');
    expect(CONSENT_DATA_CATEGORIES).toContain('remittance_history');
  });
});

// ---------------------------------------------------------------------------
// revokeConsent
// ---------------------------------------------------------------------------

describe('revokeConsent', () => {
  it('inserts a revoked row when an active grant exists', async () => {
    // effective consent SELECT
    mockQuery.mockResolvedValueOnce({
      rows: [{ status: 'granted', policy_version: '1.0', data_categories: ['credit_score'] }],
    });
    const revokedRow = makeConsentRow({ status: 'revoked', idempotency_key: 'rev-1' });
    mockQuery
      .mockResolvedValueOnce({ rows: [revokedRow], rowCount: 1 }) // INSERT revocation
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });           // audit

    const result = await revokeConsent({
      userId: USER,
      purpose: 'credit_score_processing',
      revocationReason: 'No longer needed',
      idempotencyKey: 'rev-1',
    });

    expect(result.status).toBe('revoked');

    const insertSql = mockQuery.mock.calls[1]![0] as string;
    expect(insertSql).toContain('INSERT INTO consent_ledger');
    expect(insertSql).toContain("'revoked'");
  });

  it('throws 404 when no consent record exists', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // no effective consent

    await expect(
      revokeConsent({ userId: USER, purpose: 'credit_score_processing', idempotencyKey: 'r1' }),
    ).rejects.toThrow('No consent record found');
  });

  it('throws 409 when consent is already revoked', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ status: 'revoked', policy_version: '1.0', data_categories: [] }],
    });

    await expect(
      revokeConsent({ userId: USER, purpose: 'credit_score_processing', idempotencyKey: 'r2' }),
    ).rejects.toThrow("Cannot revoke consent: current status is 'revoked'");
  });

  it('returns existing row on duplicate idempotency key', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ status: 'granted', policy_version: '1.0', data_categories: ['credit_score'] }],
    });
    const pgDup = Object.assign(new Error('dup'), { code: '23505' });
    const existing = makeConsentRow({ status: 'revoked', idempotency_key: 'dup-key' });
    mockQuery
      .mockRejectedValueOnce(pgDup)
      .mockResolvedValueOnce({ rows: [existing], rowCount: 1 });

    const result = await revokeConsent({
      userId: USER,
      purpose: 'credit_score_processing',
      idempotencyKey: 'dup-key',
    });
    expect(result.status).toBe('revoked');
  });
});

// ---------------------------------------------------------------------------
// listConsentHistory
// ---------------------------------------------------------------------------

describe('listConsentHistory', () => {
  it('returns an empty array when no history exists', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await listConsentHistory(USER);
    expect(result).toHaveLength(0);
  });

  it('applies purpose filter', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [makeConsentRow()], rowCount: 1 });
    await listConsentHistory(USER, { purpose: 'credit_score_processing' });
    const sql = mockQuery.mock.calls[0]![0] as string;
    expect(sql).toContain('purpose = $');
  });

  it('applies keyset cursor', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await listConsentHistory(USER, { cursor: '2026-01-01T00:00:00.000Z' });
    const sql = mockQuery.mock.calls[0]![0] as string;
    expect(sql).toContain('created_at < $');
  });

  it('caps limit at 200', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await listConsentHistory(USER, { limit: 9999 });
    const params = mockQuery.mock.calls[0]![1] as unknown[];
    expect(params[params.length - 1]).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// getEffectiveConsents
// ---------------------------------------------------------------------------

describe('getEffectiveConsents', () => {
  it('maps rows to EffectiveConsent objects', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'uuid-2',
          user_id: USER,
          purpose: 'remittance_analytics',
          status: 'granted',
          policy_version: '1.0',
          data_categories: ['remittance_history'],
          effective_since: new Date().toISOString(),
        },
      ],
      rowCount: 1,
    });

    const result = await getEffectiveConsents(USER);
    expect(result).toHaveLength(1);
    expect(result[0]!.purpose).toBe('remittance_analytics');
    expect(result[0]!.status).toBe('granted');

    const sql = mockQuery.mock.calls[0]![0] as string;
    expect(sql).toContain('consent_effective');
  });
});

// ---------------------------------------------------------------------------
// isConsentGranted
// ---------------------------------------------------------------------------

describe('isConsentGranted', () => {
  it('returns true when status is granted and policy version matches', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ status: 'granted', policy_version: '1.0' }],
      rowCount: 1,
    });
    const result = await isConsentGranted(USER, 'credit_score_processing', '1.0');
    expect(result).toBe(true);
  });

  it('returns false when status is revoked', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ status: 'revoked', policy_version: '1.0' }],
      rowCount: 1,
    });
    const result = await isConsentGranted(USER, 'credit_score_processing');
    expect(result).toBe(false);
  });

  it('returns false when no consent record exists', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await isConsentGranted(USER, 'credit_score_processing');
    expect(result).toBe(false);
  });

  it('returns false when policy version is older than minimum required', async () => {
    // User consented to v1.0, but current minimum is v2.0
    mockQuery.mockResolvedValueOnce({
      rows: [{ status: 'granted', policy_version: '1.0' }],
      rowCount: 1,
    });
    const result = await isConsentGranted(USER, 'credit_score_processing', '2.0');
    expect(result).toBe(false);
  });

  it('returns true when policy version is newer than minimum required', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ status: 'granted', policy_version: '2.1' }],
      rowCount: 1,
    });
    const result = await isConsentGranted(USER, 'credit_score_processing', '1.0');
    expect(result).toBe(true);
  });

  it('rejects unsupported purpose', async () => {
    await expect(
      isConsentGranted(USER, 'illegal_purpose' as never),
    ).rejects.toThrow('Unsupported consent purpose');
  });
});

// ---------------------------------------------------------------------------
// Downstream-job enforcement contract
// ---------------------------------------------------------------------------

describe('downstream job enforcement', () => {
  it('skips a user when isConsentGranted returns false', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const shouldProcess = await isConsentGranted(USER, 'credit_score_processing');
    expect(shouldProcess).toBe(false);
    // The job would skip this user — no financial data touched.
  });

  it('processes a user when isConsentGranted returns true', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ status: 'granted', policy_version: '1.0' }],
      rowCount: 1,
    });
    const shouldProcess = await isConsentGranted(USER, 'credit_score_processing');
    expect(shouldProcess).toBe(true);
  });
});
