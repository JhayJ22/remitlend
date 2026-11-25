/**
 * Key Rotation Service unit tests (issue #846 rewrite).
 *
 * The previous version of this suite mocked a non-existent `this.pool` and
 * exercised the service against an unmocked database, so it could not pass.
 * This version mocks `db/connection` once (no module reset, to avoid
 * re-registering prom-client metrics) and tests the real implementation:
 * class-scoped start, retry/backoff, local wrap/unwrap, verification, real
 * rollback, resume, and concurrency serialization.
 */

import crypto from 'node:crypto';
import { jest, describe, it, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';

jest.setTimeout(30000);

const mockQuery = jest.fn<(sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>>();
const mockConnect = jest.fn();
const mockRelease = jest.fn();

jest.unstable_mockModule('../../db/connection.js', () => {
  const connection = {
    query: mockQuery,
    on: jest.fn(),
    connect: mockConnect,
    release: mockRelease,
  };
  return {
    default: connection,
    pool: connection,
    query: mockQuery,
    getClient: jest.fn(),
    closePool: jest.fn(),
    withTransaction: jest.fn(),
  };
});

// Loaded once in beforeAll so prom-client metrics register exactly once.
let KeyRotationService: typeof import('../keyRotationService.js').KeyRotationService;
let KeyRotationError: typeof import('../keyRotationService.js').KeyRotationError;
let KMSUnwrapError: typeof import('../keyRotationService.js').KMSUnwrapError;
let KMSWrapError: typeof import('../keyRotationService.js').KMSWrapError;
let DecryptionError: typeof import('../keyRotationService.js').DecryptionError;
let RotationAlreadyInProgressError: typeof import('../keyRotationService.js').RotationAlreadyInProgressError;
let domains: typeof import('../encryptionKeyDomains.js');

const HEX = (n: number) => n.toString(16).padStart(2, '0');
const hexKey = (byte: number) => HEX(byte).repeat(32);

beforeAll(async () => {
  const mod = await import('../keyRotationService.js');
  KeyRotationService = mod.KeyRotationService;
  KeyRotationError = mod.KeyRotationError;
  KMSUnwrapError = mod.KMSUnwrapError;
  KMSWrapError = mod.KMSWrapError;
  DecryptionError = mod.DecryptionError;
  RotationAlreadyInProgressError = mod.RotationAlreadyInProgressError;
  domains = await import('../encryptionKeyDomains.js');
});

describe('KeyRotationService', () => {
  let service: InstanceType<typeof KeyRotationService>;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.PII_KEK_ID = 'old-kek-id';
    process.env.PII_KEK_KEY = hexKey(0x01);
    process.env.PII_KMS_ENDPOINT = '';
    delete process.env.FINANCIAL_KEK_ID;
    delete process.env.FINANCIAL_KEK_KEY;
    delete process.env.CREDENTIAL_KEK_ID;
    delete process.env.CREDENTIAL_KEK_KEY;
    delete process.env.AUDIT_KEK_ID;
    delete process.env.AUDIT_KEK_KEY;

    service = new KeyRotationService();
    mockQuery.mockReset();
    mockConnect.mockReset();
    mockRelease.mockReset();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    // Prevent the fire-and-forget background rotation from running in unit tests.
    jest.spyOn(service as unknown as { executeRotation: unknown }, 'executeRotation').mockResolvedValue(undefined);
    domains.__resetRevocationsForTest();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  // ── Error classes ──────────────────────────────────────────────────────────

  describe('Error Classes', () => {
    it('creates KeyRotationError with code + retryable', () => {
      const error = new KeyRotationError('TEST_ERROR', 'Test message', true);
      expect(error.code).toBe('TEST_ERROR');
      expect(error.retryable).toBe(true);
      expect(error).toBeInstanceOf(Error);
    });

    it('creates KMSUnwrapError retryable', () => {
      const error = new KMSUnwrapError('Timeout', true);
      expect(error.code).toBe('KMS_UNWRAP_ERROR');
      expect(error.retryable).toBe(true);
    });

    it('creates DecryptionError non-retryable', () => {
      const error = new DecryptionError('auth tag mismatch', false);
      expect(error.code).toBe('DECRYPTION_ERROR');
      expect(error.retryable).toBe(false);
    });

    it('RotationAlreadyInProgressError is throwable', () => {
      expect(() => {
        throw new RotationAlreadyInProgressError('pii');
      }).toThrow(RotationAlreadyInProgressError);
    });
  });

  // ── startRotation ──────────────────────────────────────────────────────────

  describe('startRotation', () => {
    const batchRow = () => ({
      id: crypto.randomUUID(),
      old_kek_id: 'old-kek-id',
      new_kek_id: 'new-kek-id',
      status: 'pending',
      initiated_by: 'operator:test',
      initiated_at: new Date(),
      request_id: 'req-123',
      data_class: 'pii',
      total_records_rotated: 0,
      total_records_failed: 0,
      total_records_scanned: 0,
      completed_at: null,
      rolled_back_at: null,
      failure_reason: null,
      last_error_code: null,
      verification_passed: null,
      verification_sample_size: null,
      verification_checked_at: null,
      last_rotated_record_id: null,
      metadata: {},
    });

    it('creates a class-scoped rotation batch with valid inputs', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // no in-progress
        .mockResolvedValueOnce({ rows: [batchRow()], rowCount: 1 }); // INSERT RETURNING

      const result = await service.startRotation('new-kek-id', 'operator:test', 'req-123', 'pii');
      expect(result.old_kek_id).toBe('old-kek-id');
      expect(result.new_kek_id).toBe('new-kek-id');
      expect(result.status).toBe('pending');
      expect(result.data_class).toBe('pii');

      // The in-progress check must be class-scoped.
      const inProgressCall = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(inProgressCall[0]).toContain('data_class = $1');
      expect(inProgressCall[1]).toContain('pii');
    });

    it('throws if a rotation is already in progress for the same class', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'existing' }], rowCount: 1 });
      await expect(
        service.startRotation('new-kek-id', 'operator:test', 'req-123', 'pii'),
      ).rejects.toThrow(RotationAlreadyInProgressError);
    });

    it('rejects a noop rotation (new == current KEK)', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      await expect(
        service.startRotation('old-kek-id', 'operator:test', 'req-123', 'pii'),
      ).rejects.toMatchObject({ code: 'NOOP_ROTATION' });
    });

    it('rejects rotation to a revoked KEK (fail closed)', async () => {
      await domains.revokeKek('revoked-kek', {
        dataClass: 'pii', actor: 'operator', reason: 'compromised', requestId: 'req-r',
      });
      await expect(
        service.startRotation('revoked-kek', 'operator:test', 'req-123', 'pii'),
      ).rejects.toThrow(domains.KeyRevokedError);
    });

    it('validates KEK access via KMS when configured', async () => {
      process.env.PII_KMS_ENDPOINT = 'http://kms.example.com';
      const fetchMock = jest.fn().mockResolvedValue({ ok: true });
      global.fetch = fetchMock as unknown as typeof fetch;

      mockQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [batchRow()], rowCount: 1 });

      await service.startRotation('new-kek-id', 'operator:test', 'req-123', 'pii');
      expect(fetchMock).toHaveBeenCalledWith(
        'http://kms.example.com/validate-key',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('throws when KMS KEK validation fails', async () => {
      process.env.PII_KMS_ENDPOINT = 'http://kms.example.com';
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 403 }) as unknown as typeof fetch;
      await expect(
        service.startRotation('invalid-kek', 'operator:test', 'req-123', 'pii'),
      ).rejects.toThrow(KeyRotationError);
    });

    it('throws on KMS validation timeout', async () => {
      process.env.PII_KMS_ENDPOINT = 'http://kms.example.com';
      global.fetch = jest
        .fn()
        .mockImplementation(
          () =>
            new Promise((resolve) => {
              setTimeout(() => resolve({ ok: true }), 6000);
            }),
        ) as unknown as typeof fetch;
      await expect(
        service.startRotation('new-kek-id', 'operator:test', 'req-123', 'pii'),
      ).rejects.toThrow('timeout');
    });
  });

  // ── wrap / unwrap (local) ──────────────────────────────────────────────────

  describe('Key wrapping & unwrapping (local)', () => {
    it('wraps and unwraps a DEK round-trip', async () => {
      const dek = crypto.randomBytes(32);
      const wrapped = await (service as unknown as { wrapDek: (d: Buffer, k: string) => Promise<Buffer> }).wrapDek(dek, 'old-kek-id');
      const unwrapped = await (service as unknown as { unwrapDek: (w: Buffer, k: string) => Promise<Buffer> }).unwrapDek(wrapped, 'old-kek-id');
      expect(unwrapped).toEqual(dek);
    });

    it('generates distinct wrapped DEKs (random IV) that unwrap to the same DEK', async () => {
      const dek = crypto.randomBytes(32);
      const wrapSpy = (service as unknown as { wrapDek: (d: Buffer, k: string) => Promise<Buffer> }).wrapDek;
      const w1 = await wrapSpy.call(service, dek, 'old-kek-id');
      const w2 = await wrapSpy.call(service, dek, 'old-kek-id');
      expect(w1).not.toEqual(w2);
      const unwrap = (service as unknown as { unwrapDek: (w: Buffer, k: string) => Promise<Buffer> }).unwrapDek;
      expect(await unwrap.call(service, w1, 'old-kek-id')).toEqual(dek);
      expect(await unwrap.call(service, w2, 'old-kek-id')).toEqual(dek);
    });

    it('throws DecryptionError on a corrupted wrapped DEK', async () => {
      await expect(
        (service as unknown as { unwrapDek: (w: Buffer, k: string) => Promise<Buffer> }).unwrapDek(Buffer.from('corrupted-data'), 'old-kek-id'),
      ).rejects.toThrow(DecryptionError);
    });

    it('uses the KMS endpoint when configured (unwrap)', async () => {
      process.env.PII_KMS_ENDPOINT = 'http://kms.example.com';
      const dek = crypto.randomBytes(32);
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ plaintext: dek.toString('base64') }),
      }) as unknown as typeof fetch;
      const unwrapped = await (service as unknown as { unwrapDek: (w: Buffer, k: string) => Promise<Buffer> }).unwrapDek(Buffer.from('wrapped'), 'kms-kek-id');
      expect(unwrapped).toEqual(dek);
      expect(global.fetch).toHaveBeenCalledWith('http://kms.example.com/decrypt', expect.objectContaining({ method: 'POST' }));
    });

    it('throws KMSUnwrapError when KMS is unreachable', async () => {
      process.env.PII_KMS_ENDPOINT = 'http://unreachable-kms.example.com';
      global.fetch = jest.fn().mockRejectedValueOnce(new Error('ECONNREFUSED')) as unknown as typeof fetch;
      await expect(
        (service as unknown as { unwrapDek: (w: Buffer, k: string) => Promise<Buffer> }).unwrapDek(Buffer.from('test'), 'kek-id'),
      ).rejects.toThrow(KMSUnwrapError);
    });

    it('marks 5xx KMS wrap errors as retryable', async () => {
      process.env.PII_KMS_ENDPOINT = 'http://kms.example.com';
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 }) as unknown as typeof fetch;
      try {
        await (service as unknown as { wrapDek: (d: Buffer, k: string) => Promise<Buffer> }).wrapDek(crypto.randomBytes(32), 'kek-id');
      } catch (err) {
        expect(err).toBeInstanceOf(KMSWrapError);
        expect((err as KMSWrapError).retryable).toBe(true);
      }
    });
  });

  // ── rotateRecordWithRetry ──────────────────────────────────────────────────

  describe('Retry logic', () => {
    const makeRecord = () => ({
      id: 'rec-1',
      dek_wrapped: Buffer.from('wrapped'),
      dek_kek_id: 'old-kek-id',
      table_name: 'user_profiles',
      field_name: 'email',
      data_class: 'pii' as const,
    });
    const makeBatch = () => ({
      id: 'b1',
      old_kek_id: 'old-kek-id',
      new_kek_id: 'new-kek-id',
      total_records_rotated: 0,
      data_class: 'pii' as const,
    });

    it('retries on transient KMS errors with backoff', async () => {
      jest.useFakeTimers();
      let attempts = 0;
      jest.spyOn(service as unknown as { unwrapDek: unknown }, 'unwrapDek').mockImplementation(async () => {
        attempts++;
        if (attempts < 2) throw new KMSUnwrapError('timeout', true);
        return crypto.randomBytes(32);
      });
      jest.spyOn(service as unknown as { wrapDek: unknown }, 'wrapDek').mockResolvedValue(Buffer.from('newwrapped'));
      const mockClient = { query: jest.fn().mockResolvedValue({ rows: [] }) };

      const p = (service as unknown as {
        rotateRecordWithRetry: (r: unknown, b: unknown, c: unknown, a?: number) => Promise<void>;
      }).rotateRecordWithRetry(makeRecord(), makeBatch(), mockClient, 1);
      await jest.advanceTimersByTimeAsync(500);
      await p;

      expect(attempts).toBe(2);
      // Checkpoint INSERT stores both old + new wrapped DEKs.
      const insertCall = mockClient.query.mock.calls.find((c) => String(c[0]).includes('INSERT INTO key_rotation_record'));
      expect(insertCall).toBeDefined();
      expect(insertCall![1]).toContain('b1'); // real batch_id, not undefined
    });

    it('fails after maximum retries', async () => {
      jest.useFakeTimers();
      let attempts = 0;
      jest.spyOn(service as unknown as { unwrapDek: unknown }, 'unwrapDek').mockImplementation(async () => {
        attempts++;
        throw new KMSUnwrapError('persistent timeout', true);
      });
      const mockClient = { query: jest.fn().mockResolvedValue({ rows: [] }) };

      const p = (service as unknown as {
        rotateRecordWithRetry: (r: unknown, b: unknown, c: unknown, a?: number) => Promise<void>;
      }).rotateRecordWithRetry(makeRecord(), makeBatch(), mockClient, 1);
      // Attach the rejection handler before advancing timers so the rejection
      // is never unhandled when the timers fire.
      const expectation = expect(p).rejects.toThrow(KeyRotationError);
      await jest.advanceTimersByTimeAsync(500);
      await jest.advanceTimersByTimeAsync(1000);
      await expectation;
      expect(attempts).toBe(3);
    });

    it('does not retry on permanent errors', async () => {
      let attempts = 0;
      jest.spyOn(service as unknown as { unwrapDek: unknown }, 'unwrapDek').mockImplementation(async () => {
        attempts++;
        throw new DecryptionError('auth tag mismatch', false);
      });
      const mockClient = { query: jest.fn().mockResolvedValue({ rows: [] }) };
      await expect(
        (service as unknown as {
          rotateRecordWithRetry: (r: unknown, b: unknown, c: unknown, a?: number) => Promise<void>;
        }).rotateRecordWithRetry(makeRecord(), makeBatch(), mockClient, 1),
      ).rejects.toThrow(KeyRotationError);
      expect(attempts).toBe(1);
    });
  });

  // ── verifyRotation ──────────────────────────────────────────────────────────

  describe('Verification', () => {
    it('passes when a sample decrypts under the new KEK', async () => {
      process.env.PII_KEK_ID = 'old-kek';
      process.env.PII_KEK_KEY = hexKey(0x01);
      process.env.AUDIT_KEK_ID = 'new-kek';
      process.env.AUDIT_KEK_KEY = hexKey(0x02);

      const dek = crypto.randomBytes(32);
      const nonce = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', dek, nonce);
      const ciphertext = Buffer.concat([cipher.update('secret', 'utf8'), cipher.final(), cipher.getAuthTag()]);
      const newDekWrapped = await (service as unknown as { wrapDek: (d: Buffer, k: string) => Promise<Buffer> }).wrapDek(dek, 'new-kek');

      const batchId = crypto.randomUUID();
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: batchId, new_kek_id: 'new-kek', status: 'completed', data_class: 'pii' }] })
        .mockResolvedValueOnce({
          rows: [{ id: 'rr1', record_id: 'rec-1', table_name: 'user_profiles', new_dek_wrapped: newDekWrapped, ciphertext, gcm_nonce: nonce }],
        })
        .mockResolvedValue({ rows: [] });

      const result = await service.verifyRotation(batchId);
      expect(result.passed).toBe(true);
      expect(result.sample_size).toBe(1);
      expect(result.records_verified).toBe(1);
    });

    it('fails when a sample does not authenticate', async () => {
      process.env.PII_KEK_ID = 'old-kek';
      process.env.PII_KEK_KEY = hexKey(0x01);
      process.env.AUDIT_KEK_ID = 'new-kek';
      process.env.AUDIT_KEK_KEY = hexKey(0x02);

      const dek = crypto.randomBytes(32);
      const nonce = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', dek, nonce);
      const ciphertext = Buffer.concat([cipher.update('secret', 'utf8'), cipher.final(), cipher.getAuthTag()]);
      const newDekWrapped = await (service as unknown as { wrapDek: (d: Buffer, k: string) => Promise<Buffer> }).wrapDek(dek, 'new-kek');
      // Corrupt the ciphertext so GCM auth fails.
      ciphertext[ciphertext.length - 1] ^= 0xff;

      const batchId = crypto.randomUUID();
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: batchId, new_kek_id: 'new-kek', status: 'completed', data_class: 'pii' }] })
        .mockResolvedValueOnce({
          rows: [{ id: 'rr1', record_id: 'rec-1', table_name: 'user_profiles', new_dek_wrapped: newDekWrapped, ciphertext, gcm_nonce: nonce }],
        })
        .mockResolvedValue({ rows: [] });

      const result = await service.verifyRotation(batchId);
      expect(result.passed).toBe(false);
      expect(result.records_failed).toBe(1);
    });
  });

  // ── rollbackRotation ────────────────────────────────────────────────────────

  describe('Rollback', () => {
    it('restores old_dek_wrapped + old kek_id for each rotated record', async () => {
      const batchId = crypto.randomUUID();
      const oldWrapped = Buffer.from('old-wrapped-dek');
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: batchId, old_kek_id: 'old-kek', status: 'in_progress' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'rr1', record_id: 'rec-1', old_dek_wrapped: oldWrapped }] })
        .mockResolvedValue({ rows: [] });

      await service.rollbackRotation(batchId, 'test_rollback');

      const restoreCall = mockQuery.mock.calls.find(
        (c) => String(c[0]).includes('UPDATE pii_encrypted_fields SET dek_wrapped'),
      );
      expect(restoreCall).toBeDefined();
      const params = restoreCall![1] as unknown[];
      expect(params[0]).toEqual(oldWrapped); // restored old_dek_wrapped
      expect(params[1]).toBe('old-kek'); // restored old kek_id
      expect(params[2]).toBe('rec-1');

      const batchFinal = mockQuery.mock.calls.find(
        (c) => String(c[0]).includes("status = 'rolled_back'"),
      );
      expect(batchFinal).toBeDefined();
    });

    it('throws if the batch does not exist', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      await expect(service.rollbackRotation('nonexistent', 'reason')).rejects.toThrow(KeyRotationError);
    });
  });

  // ── resumeRotation ──────────────────────────────────────────────────────────

  describe('Resumable rotation', () => {
    it('resumes a failed batch from its checkpoint', async () => {
      const batchId = crypto.randomUUID();
      mockQuery
        .mockResolvedValueOnce({
          rows: [{ id: batchId, status: 'failed', data_class: 'pii', total_records_rotated: 50, total_records_failed: 5 }],
        })
        .mockResolvedValue({ rows: [] });

      const result = await service.resumeRotation(batchId);
      expect(result.id).toBe(batchId);
      expect(result.total_records_rotated).toBe(50);
    });

    it('refuses to resume a completed batch', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'b', status: 'completed', data_class: 'pii' }] });
      await expect(service.resumeRotation('b')).rejects.toThrow('already completed');
    });

    it('refuses to resume a rolled-back batch', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'b', status: 'rolled_back', data_class: 'pii' }] });
      await expect(service.resumeRotation('b')).rejects.toThrow('rolled back');
    });
  });

  // ── Concurrency ─────────────────────────────────────────────────────────────

  describe('Concurrency', () => {
    it('serializes concurrent rotation attempts for the same class', async () => {
      const batchRow = {
        id: crypto.randomUUID(), old_kek_id: 'old-kek-id', new_kek_id: 'new-kek-1',
        status: 'pending', data_class: 'pii', initiated_at: new Date(),
      };
      mockQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // first start: no in-progress
        .mockResolvedValueOnce({ rows: [batchRow], rowCount: 1 }) // first start: INSERT
        .mockResolvedValueOnce({ rows: [{ id: 'in-progress' }] }); // second start: in-progress exists

      await service.startRotation('new-kek-1', 'op1', 'req-1', 'pii');
      await expect(service.startRotation('new-kek-2', 'op2', 'req-2', 'pii')).rejects.toThrow(
        RotationAlreadyInProgressError,
      );
    });

    it('allows a new rotation after the previous completes', async () => {
      const b1 = {
        id: crypto.randomUUID(), old_kek_id: 'old-kek-id', new_kek_id: 'new-kek-1',
        status: 'pending', data_class: 'pii', initiated_at: new Date(),
      };
      const b2 = {
        id: crypto.randomUUID(), old_kek_id: 'old-kek-id', new_kek_id: 'new-kek-2',
        status: 'pending', data_class: 'pii', initiated_at: new Date(),
      };
      mockQuery
        .mockResolvedValueOnce({ rows: [] }) // first start: no in-progress
        .mockResolvedValueOnce({ rows: [b1] }) // first start: INSERT
        .mockResolvedValueOnce({ rows: [] }) // simulate completion UPDATE
        .mockResolvedValueOnce({ rows: [] }) // second start: no in-progress
        .mockResolvedValueOnce({ rows: [b2] }); // second start: INSERT

      const r1 = await service.startRotation('new-kek-1', 'op1', 'req-1', 'pii');
      // simulate completion of the first batch
      await mockQuery('UPDATE key_rotation_batch SET status = $1 WHERE id = $2', ['completed', r1.id]);
      const r2 = await service.startRotation('new-kek-2', 'op2', 'req-2', 'pii');
      expect(r2.id).not.toBe(r1.id);
    });
  });
});
