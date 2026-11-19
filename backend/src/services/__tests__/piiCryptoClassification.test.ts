/**
 * Unit tests for class-aware field-level encryption (issue #846).
 *
 * Proves, with the database mocked:
 *  - round-trip encrypt/decrypt works per class,
 *  - a class's wrapped DEK cannot be unwrapped by another class's KEK
 *    (key-domain isolation),
 *  - backward compatibility: with only the legacy PII KEK configured, every
 *    class shares it and ciphertext stays readable,
 *  - revocation fails *closed* for the revoked class only, while unrelated
 *    classes keep encrypting/decrypting (audit records survive).
 */

import { jest } from '@jest/globals';

jest.setTimeout(30000);

const loadPiiCrypto = async () => {
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

  const piiCrypto = await import('../piiCrypto.js');
  const domains = await import('../encryptionKeyDomains.js');
  return { piiCrypto, domains, mockQuery };
};

const HEX = (n: number) => n.toString(16).padStart(2, '0');
const hexKey = (byte: number) => HEX(byte).repeat(32);

describe('piiCrypto key separation', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // Configure four distinct KEK domains.
  const setDistinctKeys = () => {
    process.env.PII_KEK_ID = 'pii-v1';
    process.env.PII_KEK_KEY = hexKey(0x11);
    process.env.FINANCIAL_KEK_ID = 'fin-v1';
    process.env.FINANCIAL_KEK_KEY = hexKey(0x22);
    process.env.CREDENTIAL_KEK_ID = 'cred-v1';
    process.env.CREDENTIAL_KEK_KEY = hexKey(0x33);
    process.env.AUDIT_KEK_ID = 'audit-v1';
    process.env.AUDIT_KEK_KEY = hexKey(0x44);
    process.env.PII_KMS_ENDPOINT = '';
  };

  describe('round-trip per class', () => {
    it('encrypts and decrypts a pii field', async () => {
      const { piiCrypto } = await loadPiiCrypto();
      setDistinctKeys();
      const rec = await piiCrypto.encryptField('user@example.com', 'pii');
      expect(rec.data_class).toBe('pii');
      expect(rec.dek_kek_id).toBe('pii-v1');

      const plaintext = await piiCrypto.decryptField(
        'rec-1', 'email', rec.ciphertext, rec.gcm_nonce, rec.dek_wrapped, rec.dek_kek_id,
        'support', 'view-profile', 'req-1', 'pii',
      );
      expect(plaintext).toBe('user@example.com');
    });

    it('encrypts and decrypts a financial field', async () => {
      const { piiCrypto } = await loadPiiCrypto();
      setDistinctKeys();
      const rec = await piiCrypto.encryptField('AAAAA...xdr-blob', 'financial');
      expect(rec.data_class).toBe('financial');
      expect(rec.dek_kek_id).toBe('fin-v1');

      const plaintext = await piiCrypto.decryptField(
        'rec-2', 'xdr', rec.ciphertext, rec.gcm_nonce, rec.dek_wrapped, rec.dek_kek_id,
        'transaction-processor', 'submit-tx', 'req-2', 'financial',
      );
      expect(plaintext).toBe('AAAAA...xdr-blob');
    });
  });

  describe('key-domain isolation', () => {
    it('a financial wrapped DEK cannot be unwrapped with the pii KEK', async () => {
      const { piiCrypto } = await loadPiiCrypto();
      setDistinctKeys();
      const rec = await piiCrypto.encryptField('financial-secret', 'financial');

      // Forcing the pii KEK id must NOT decrypt financial data: the pii key
      // cannot authenticate the financial-wrapped DEK.
      await expect(
        piiCrypto.decryptField(
          'rec-3', 'xdr', rec.ciphertext, rec.gcm_nonce, rec.dek_wrapped, 'pii-v1',
          'transaction-processor', 'submit-tx', 'req-3', 'financial',
        ),
      ).rejects.toThrow();
    });

    it('a pii wrapped DEK cannot be unwrapped with the financial KEK', async () => {
      const { piiCrypto } = await loadPiiCrypto();
      setDistinctKeys();
      const rec = await piiCrypto.encryptField('pii-secret', 'pii');
      await expect(
        piiCrypto.decryptField(
          'rec-4', 'email', rec.ciphertext, rec.gcm_nonce, rec.dek_wrapped, 'fin-v1',
          'support', 'view-profile', 'req-4', 'pii',
        ),
      ).rejects.toThrow();
    });

    it('ciphertext is distinct across classes (no shared DEK domain leakage)', async () => {
      const { piiCrypto } = await loadPiiCrypto();
      setDistinctKeys();
      const a = await piiCrypto.encryptField('same-plaintext', 'pii');
      const b = await piiCrypto.encryptField('same-plaintext', 'financial');
      // Distinct KEK ids recorded per row.
      expect(a.dek_kek_id).not.toBe(b.dek_kek_id);
      // Fresh per-field DEK → different ciphertext.
      expect(a.ciphertext).not.toEqual(b.ciphertext);
    });
  });

  describe('backward compatibility (single legacy KEK)', () => {
    it('with only PII_KEK_* set, all classes share it and stay readable', async () => {
      const { piiCrypto } = await loadPiiCrypto();
      process.env.PII_KEK_ID = 'legacy-kek';
      process.env.PII_KEK_KEY = hexKey(0xaa);
      delete process.env.FINANCIAL_KEK_ID;
      delete process.env.FINANCIAL_KEK_KEY;
      delete process.env.CREDENTIAL_KEK_ID;
      delete process.env.AUDIT_KEK_ID;
      process.env.PII_KMS_ENDPOINT = '';

      const rec = await piiCrypto.encryptField('legacy-financial', 'financial');
      // Falls back to the legacy PII KEK id.
      expect(rec.dek_kek_id).toBe('legacy-kek');
      const plaintext = await piiCrypto.decryptField(
        'rec-5', 'xdr', rec.ciphertext, rec.gcm_nonce, rec.dek_wrapped, rec.dek_kek_id,
        'transaction-processor', 'submit-tx', 'req-5', 'financial',
      );
      expect(plaintext).toBe('legacy-financial');
    });
  });

  describe('revocation fails closed for one class only', () => {
    it('revoking the pii KEK blocks pii encrypt/decrypt but not financial', async () => {
      const { piiCrypto, domains, mockQuery } = await loadPiiCrypto();
      setDistinctKeys();
      domains.__resetRevocationsForTest();

      // Pre-existing pii + financial ciphertext.
      const piiRec = await piiCrypto.encryptField('pii-secret', 'pii');
      const finRec = await piiCrypto.encryptField('fin-secret', 'financial');

      // Revoke the PII KEK.
      await domains.revokeKek('pii-v1', {
        dataClass: 'pii', actor: 'operator', reason: 'compromise', requestId: 'req-r',
      });
      expect(domains.isKekRevoked('pii-v1')).toBe(true);
      expect(domains.isKekRevoked('fin-v1')).toBe(false);

      // PII decrypt fails closed (and audits the denial).
      mockQuery.mockClear();
      await expect(
        piiCrypto.decryptField(
          'rec-6', 'email', piiRec.ciphertext, piiRec.gcm_nonce, piiRec.dek_wrapped, 'pii-v1',
          'support', 'view-profile', 'req-6', 'pii',
        ),
      ).rejects.toThrow(domains.KeyRevokedError);
      // The denial is still recorded in the audit trail.
      expect(mockQuery).toHaveBeenCalled();
      const denialCall = mockQuery.mock.calls.find((c) => {
        const params = c[1] as unknown[];
        return Array.isArray(params) && params.some((p) => typeof p === 'string' && p.includes('DENIED:revoked_kek'));
      });
      expect(denialCall).toBeDefined();

      // PII encrypt also fails closed (no new ciphertext under a revoked KEK).
      await expect(piiCrypto.encryptField('new-pii', 'pii')).rejects.toThrow(domains.KeyRevokedError);

      // Financial encrypt + decrypt are unaffected — unrelated data is intact.
      const newFin = await piiCrypto.encryptField('new-fin', 'financial');
      const finPlain = await piiCrypto.decryptField(
        'rec-7', 'xdr', finRec.ciphertext, finRec.gcm_nonce, finRec.dek_wrapped, 'fin-v1',
        'transaction-processor', 'submit-tx', 'req-7', 'financial',
      );
      expect(finPlain).toBe('fin-secret');
      const newFinPlain = await piiCrypto.decryptField(
        'rec-8', 'xdr', newFin.ciphertext, newFin.gcm_nonce, newFin.dek_wrapped, 'fin-v1',
        'transaction-processor', 'submit-tx', 'req-8', 'financial',
      );
      expect(newFinPlain).toBe('new-fin');
    });
  });
});
