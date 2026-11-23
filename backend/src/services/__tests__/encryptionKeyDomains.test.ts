/**
 * Unit tests for encryption key-domain separation by data classification
 * (issue #846).
 *
 * Covers: classification, per-class KEK resolution + backward-compat fallback,
 * per-class access roles, and the fail-closed revocation registry. No real
 * database is required; `db/connection` is mocked so revocation persists only
 * in the in-memory set.
 */

import { jest } from '@jest/globals';

jest.setTimeout(30000);

const loadDomains = async () => {
  jest.resetModules();

  const mockQuery = jest
    .fn<(sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>>()
    .mockResolvedValue({ rows: [], rowCount: 0 });
  const mockConnect = jest.fn().mockResolvedValue({ query: mockQuery, release: jest.fn() });
  const connection = { query: mockQuery, on: jest.fn(), connect: mockConnect };

  jest.unstable_mockModule('../../db/connection.js', () => ({
    default: connection,
    pool: connection,
    query: mockQuery,
    getClient: jest.fn(),
    closePool: jest.fn(),
    withTransaction: jest.fn(),
  }));

  const mod = await import('../encryptionKeyDomains.js');
  return { mod, mockQuery };
};

const HEX = (n: number) => n.toString(16).padStart(2, '0');
const hexKey = (byte: number) => HEX(byte).repeat(32);

describe('encryptionKeyDomains', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── Classification ─────────────────────────────────────────────────────────

  describe('classifyField', () => {
    it('maps known sensitive fields to their data class', async () => {
      const { mod } = await loadDomains();
      expect(mod.classifyField('user_profiles', 'email')).toBe('pii');
      expect(mod.classifyField('user_profiles', 'phone')).toBe('pii');
      expect(mod.classifyField('remittances', 'xdr')).toBe('financial');
      expect(mod.classifyField('transaction_submissions', 'result_xdr')).toBe('financial');
      expect(mod.classifyField('webhook_secrets', 'secret')).toBe('credential');
      expect(mod.classifyField('audit_logs', 'payload')).toBe('audit');
      expect(mod.classifyField('pii_access_log', 'reason')).toBe('audit');
    });

    it('defaults unknown fields to pii (conservative) and does not throw', async () => {
      const { mod } = await loadDomains();
      expect(mod.classifyField('unknown_table', 'mystery_field')).toBe('pii');
    });

    it('lists exactly the fields registered for a class', async () => {
      const { mod } = await loadDomains();
      const pii = mod.fieldsForClass('pii');
      expect(pii).toContainEqual({ table: 'user_profiles', field: 'email' });
      const financial = mod.fieldsForClass('financial');
      expect(financial).toContainEqual({ table: 'remittances', field: 'xdr' });
    });
  });

  // ── Per-class KEK resolution ───────────────────────────────────────────────

  describe('resolveKekId / resolveKekKey', () => {
    it('uses the class-specific KEK env when set', async () => {
      const { mod } = await loadDomains();
      process.env.PII_KEK_ID = 'pii-v1';
      process.env.PII_KEK_KEY = hexKey(0x11);
      process.env.FINANCIAL_KEK_ID = 'fin-v1';
      process.env.FINANCIAL_KEK_KEY = hexKey(0x22);
      process.env.CREDENTIAL_KEK_ID = 'cred-v1';
      process.env.CREDENTIAL_KEK_KEY = hexKey(0x33);
      process.env.AUDIT_KEK_ID = 'audit-v1';
      process.env.AUDIT_KEK_KEY = hexKey(0x44);

      expect(mod.resolveKekId('pii')).toBe('pii-v1');
      expect(mod.resolveKekId('financial')).toBe('fin-v1');
      expect(mod.resolveKekId('credential')).toBe('cred-v1');
      expect(mod.resolveKekId('audit')).toBe('audit-v1');

      expect(mod.resolveKekKey('pii').toString('hex')).toBe(hexKey(0x11));
      expect(mod.resolveKekKey('financial').toString('hex')).toBe(hexKey(0x22));
      expect(mod.resolveKek('pii').kekId).toBe('pii-v1');
      expect(mod.resolveKek('financial').kmsEndpoint).toBe('');
    });

    it('falls back to the legacy PII KEK when a class KEK is unset (backward compat)', async () => {
      const { mod } = await loadDomains();
      process.env.PII_KEK_ID = 'shared-kek';
      process.env.PII_KEK_KEY = hexKey(0xaa);
      delete process.env.FINANCIAL_KEK_ID;
      delete process.env.FINANCIAL_KEK_KEY;
      delete process.env.CREDENTIAL_KEK_ID;
      delete process.env.AUDIT_KEK_ID;

      // Unset classes inherit the PII KEK id + material so existing ciphertext
      // stays readable (single-KEK legacy behaviour).
      expect(mod.resolveKekId('financial')).toBe('shared-kek');
      expect(mod.resolveKekId('credential')).toBe('shared-kek');
      expect(mod.resolveKekKey('financial').toString('hex')).toBe(hexKey(0xaa));
    });

    it('uses the legacy default-kek / all-zeros when nothing is configured', async () => {
      const { mod } = await loadDomains();
      delete process.env.PII_KEK_ID;
      delete process.env.PII_KEK_KEY;
      delete process.env.FINANCIAL_KEK_ID;
      delete process.env.FINANCIAL_KEK_KEY;
      delete process.env.CREDENTIAL_KEK_ID;
      delete process.env.AUDIT_KEK_ID;

      expect(mod.resolveKekId('pii')).toBe('default-kek');
      expect(mod.resolveKekKey('pii').toString('hex')).toBe('0'.repeat(64));
    });

    it('separates key material across classes when distinct env is set', async () => {
      const { mod } = await loadDomains();
      process.env.PII_KEK_ID = 'pii-v1';
      process.env.PII_KEK_KEY = hexKey(0x11);
      process.env.FINANCIAL_KEK_ID = 'fin-v1';
      process.env.FINANCIAL_KEK_KEY = hexKey(0x22);
      expect(mod.resolveKekKey('pii')).not.toEqual(mod.resolveKekKey('financial'));
    });
  });

  // ── Per-class access roles ─────────────────────────────────────────────────

  describe('canDecryptClass / assertCanDecrypt', () => {
    it('grants each principal only its authorised classes', async () => {
      const { mod } = await loadDomains();
      expect(mod.canDecryptClass('admin', 'pii')).toBe(true);
      expect(mod.canDecryptClass('admin', 'audit')).toBe(true);
      expect(mod.canDecryptClass('admin', 'financial')).toBe(false);
      expect(mod.canDecryptClass('admin', 'credential')).toBe(false);

      expect(mod.canDecryptClass('support', 'pii')).toBe(true);
      expect(mod.canDecryptClass('support', 'financial')).toBe(false);

      expect(mod.canDecryptClass('transaction-processor', 'financial')).toBe(true);
      expect(mod.canDecryptClass('transaction-processor', 'pii')).toBe(false);

      expect(mod.canDecryptClass('credential-rotator', 'credential')).toBe(true);
      expect(mod.canDecryptClass('credential-rotator', 'pii')).toBe(false);

      expect(mod.canDecryptClass('auditor', 'audit')).toBe(true);
      expect(mod.canDecryptClass('auditor', 'pii')).toBe(false);
    });

    it('grants no class to system, borrower, lender, anonymous', async () => {
      const { mod } = await loadDomains();
      for (const principal of ['system', 'borrower', 'lender', 'anonymous'] as const) {
        for (const cls of mod.DATA_CLASSES) {
          expect(mod.canDecryptClass(principal, cls)).toBe(false);
        }
      }
    });

    it('no single non-admin principal can decrypt every class', async () => {
      const { mod } = await loadDomains();
      // financial, credential, and audit are mutually exclusive to three
      // different internal roles — proving access separation.
      const principals = ['support', 'transaction-processor', 'credential-rotator', 'auditor'] as const;
      for (const p of principals) {
        const granted = mod.DATA_CLASSES.filter((c) => mod.canDecryptClass(p, c));
        expect(granted).toHaveLength(1);
      }
    });

    it('assertCanDecrypt throws KeyAccessDeniedError when unauthorised', async () => {
      const { mod } = await loadDomains();
      expect(() => mod.assertCanDecrypt('borrower', 'pii')).toThrow(mod.KeyAccessDeniedError);
      expect(() => mod.assertCanDecrypt('transaction-processor', 'pii')).toThrow(mod.KeyAccessDeniedError);
      expect(() => mod.assertCanDecrypt('admin', 'pii')).not.toThrow();
    });
  });

  // ── Revocation registry (fail-closed) ─────────────────────────────────────

  describe('revocation', () => {
    it('isKekRevoked is false for an unrevoked KEK', async () => {
      const { mod } = await loadDomains();
      mod.__resetRevocationsForTest();
      expect(mod.isKekRevoked('kek-x')).toBe(false);
    });

    it('revokeKek marks the KEK revoked in memory and persists to the DB', async () => {
      const { mod, mockQuery } = await loadDomains();
      mod.__resetRevocationsForTest();
      await mod.revokeKek('pii-v1', {
        dataClass: 'pii',
        actor: 'operator',
        reason: 'suspected compromise',
        requestId: 'req-1',
      });

      expect(mod.isKekRevoked('pii-v1')).toBe(true);
      expect(mockQuery).toHaveBeenCalled();
      const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('kek_revocations');
      expect(params[0]).toBe('pii-v1');
      expect(params[1]).toBe('pii');
    });

    it('revocation takes effect even if the DB write fails (fail-closed in-process)', async () => {
      const { mod, mockQuery } = await loadDomains();
      mod.__resetRevocationsForTest();
      mockQuery.mockRejectedValueOnce(new Error('db down'));
      await mod.revokeKek('pii-v2', {
        dataClass: 'pii',
        actor: 'operator',
        reason: 'db-down-revoke',
        requestId: 'req-2',
      });
      expect(mod.isKekRevoked('pii-v2')).toBe(true);
    });

    it('revoking one class KEK does not revoke another class KEK', async () => {
      const { mod } = await loadDomains();
      mod.__resetRevocationsForTest();
      await mod.revokeKek('pii-v1', {
        dataClass: 'pii',
        actor: 'operator',
        reason: 'rotate',
        requestId: 'req-3',
      });
      expect(mod.isKekRevoked('pii-v1')).toBe(true);
      expect(mod.isKekRevoked('fin-v1')).toBe(false);
      expect(mod.isKekRevoked('audit-v1')).toBe(false);
    });

    it('loadRevocations seeds the in-memory set from the DB', async () => {
      const { mod, mockQuery } = await loadDomains();
      mod.__resetRevocationsForTest();
      mockQuery.mockResolvedValueOnce({
        rows: [{ kek_id: 'loaded-kek-1' }, { kek_id: 'loaded-kek-2' }],
        rowCount: 2,
      });
      await mod.loadRevocations();
      expect(mod.isKekRevoked('loaded-kek-1')).toBe(true);
      expect(mod.isKekRevoked('loaded-kek-2')).toBe(true);
      expect(mod.isKekRevoked('not-loaded')).toBe(false);
    });
  });

  // ── Error types ───────────────────────────────────────────────────────────

  describe('errors', () => {
    it('KeyRevokedError carries the kekId', async () => {
      const { mod } = await loadDomains();
      const err = new mod.KeyRevokedError('pii-v1');
      expect(err.kekId).toBe('pii-v1');
      expect(err).toBeInstanceOf(Error);
    });
  });
});
