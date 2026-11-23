/**
 * Tests for evidenceProvenanceService (#848).
 *
 * Coverage:
 *  - canonicalize: determinism and sensitivity
 *  - computeEvidenceDigest: changes with content, produces 64-char hex
 *  - computeRowHmac: changes with any input column, timing-safe comparison
 *  - verifyRowHmac: true for untampered, false for tampered
 *  - recordEvidence: happy path, idempotency (duplicate returns existing),
 *    validation guards (bad record_type, bad verification_result, empty ref/source)
 *  - getEvidence: found and 404
 *  - findEvidence: most recent by (record_type, record_ref)
 *  - listEvidence: filters, keyset cursor, limit cap
 *  - verifyEvidence: round-trip HMAC verification
 *  - No raw payload stored: the INSERT SQL never contains the record object
 *  - Dependency failure: DB error propagates
 */

import { jest, describe, it, expect, beforeAll, beforeEach } from '@jest/globals';

type Res = { rows: unknown[]; rowCount?: number };
const mockQuery = jest.fn<(sql: string, params?: unknown[]) => Promise<Res>>();

let canonicalize: typeof import('../evidenceProvenanceService.js').canonicalize;
let computeEvidenceDigest: typeof import('../evidenceProvenanceService.js').computeEvidenceDigest;
let computeRowHmac: typeof import('../evidenceProvenanceService.js').computeRowHmac;
let verifyRowHmac: typeof import('../evidenceProvenanceService.js').verifyRowHmac;
let recordEvidence: typeof import('../evidenceProvenanceService.js').recordEvidence;
let getEvidence: typeof import('../evidenceProvenanceService.js').getEvidence;
let findEvidence: typeof import('../evidenceProvenanceService.js').findEvidence;
let listEvidence: typeof import('../evidenceProvenanceService.js').listEvidence;
let verifyEvidence: typeof import('../evidenceProvenanceService.js').verifyEvidence;
let EVIDENCE_RECORD_TYPES: typeof import('../evidenceProvenanceService.js').EVIDENCE_RECORD_TYPES;
let VERIFICATION_RESULTS: typeof import('../evidenceProvenanceService.js').VERIFICATION_RESULTS;
let EvidenceRecord: typeof import('../evidenceProvenanceService.js').EvidenceRecord;

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

  const mod = await import('../evidenceProvenanceService.js');
  canonicalize = mod.canonicalize;
  computeEvidenceDigest = mod.computeEvidenceDigest;
  computeRowHmac = mod.computeRowHmac;
  verifyRowHmac = mod.verifyRowHmac;
  recordEvidence = mod.recordEvidence;
  getEvidence = mod.getEvidence;
  findEvidence = mod.findEvidence;
  listEvidence = mod.listEvidence;
  verifyEvidence = mod.verifyEvidence;
  EVIDENCE_RECORD_TYPES = mod.EVIDENCE_RECORD_TYPES;
  VERIFICATION_RESULTS = mod.VERIFICATION_RESULTS;
  EvidenceRecord = mod.EvidenceRecord;
});

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

// ---------------------------------------------------------------------------
// canonicalize
// ---------------------------------------------------------------------------

describe('canonicalize', () => {
  it('is deterministic regardless of key order', () => {
    expect(canonicalize({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonicalize({ a: { c: 3, d: 2 }, b: 1 }),
    );
  });

  it('distinguishes different values', () => {
    expect(canonicalize({ x: 1 })).not.toBe(canonicalize({ x: 2 }));
  });

  it('handles arrays and primitives', () => {
    expect(canonicalize([1, 2, 3])).toBe('[1,2,3]');
    expect(canonicalize('hello')).toBe('"hello"');
    expect(canonicalize(42)).toBe('42');
    expect(canonicalize(null)).toBe('null');
  });
});

// ---------------------------------------------------------------------------
// computeEvidenceDigest
// ---------------------------------------------------------------------------

describe('computeEvidenceDigest', () => {
  it('produces a 64-character lowercase hex string', () => {
    const digest = computeEvidenceDigest({ a: 1 });
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when content changes', () => {
    expect(computeEvidenceDigest({ eventId: 'e1' })).not.toBe(
      computeEvidenceDigest({ eventId: 'e2' }),
    );
  });

  it('is deterministic for the same content regardless of key order', () => {
    expect(computeEvidenceDigest({ b: 2, a: 1 })).toBe(
      computeEvidenceDigest({ a: 1, b: 2 }),
    );
  });
});

// ---------------------------------------------------------------------------
// computeRowHmac
// ---------------------------------------------------------------------------

describe('computeRowHmac', () => {
  it('produces a 64-character hex string', () => {
    const hmac = computeRowHmac('id1', 'indexer_event', 'ref1', 'src1', 'abc', '2026-01-01T00:00:00.000Z', 'verified');
    expect(hmac).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when any input column changes', () => {
    const base = computeRowHmac('id1', 'indexer_event', 'ref1', 'src1', 'digest', 'ts', 'verified');
    expect(computeRowHmac('id2', 'indexer_event', 'ref1', 'src1', 'digest', 'ts', 'verified')).not.toBe(base);
    expect(computeRowHmac('id1', 'quarantine_event', 'ref1', 'src1', 'digest', 'ts', 'verified')).not.toBe(base);
    expect(computeRowHmac('id1', 'indexer_event', 'ref2', 'src1', 'digest', 'ts', 'verified')).not.toBe(base);
    expect(computeRowHmac('id1', 'indexer_event', 'ref1', 'src2', 'digest', 'ts', 'verified')).not.toBe(base);
    expect(computeRowHmac('id1', 'indexer_event', 'ref1', 'src1', 'other', 'ts', 'verified')).not.toBe(base);
    expect(computeRowHmac('id1', 'indexer_event', 'ref1', 'src1', 'digest', 'other', 'verified')).not.toBe(base);
    expect(computeRowHmac('id1', 'indexer_event', 'ref1', 'src1', 'digest', 'ts', 'rejected')).not.toBe(base);
  });
});

// ---------------------------------------------------------------------------
// verifyRowHmac
// ---------------------------------------------------------------------------

describe('verifyRowHmac', () => {
  function makeRecord(overrides: Record<string, unknown> = {}): typeof EvidenceRecord {
    const id = 'id-1';
    const recordType = 'indexer_event';
    const recordRef = 'ref-1';
    const sourceIdentity = 'contract:C...';
    const evidenceDigest = 'abc123';
    const ingestedAt = new Date('2026-01-01T00:00:00.000Z');
    const verificationResult = 'verified';

    const rowHmac = computeRowHmac(
      id, recordType, recordRef, sourceIdentity, evidenceDigest,
      ingestedAt.toISOString(), verificationResult,
    );

    return {
      id,
      recordType,
      recordRef,
      sourceIdentity,
      evidenceDigest,
      digestAlgorithm: 'sha256',
      ingestedAt,
      verificationResult,
      verificationDetail: {},
      signingKeyId: 'key-1',
      rowHmac,
      ...overrides,
    };
  }

  it('returns true for an untampered row', () => {
    const record = makeRecord();
    expect(verifyRowHmac(record)).toBe(true);
  });

  it('returns false when rowHmac is tampered', () => {
    const record = makeRecord({ rowHmac: '0'.repeat(64) });
    expect(verifyRowHmac(record)).toBe(false);
  });

  it('returns false when evidenceDigest is tampered', () => {
    const record = makeRecord({ evidenceDigest: 'tampered' });
    expect(verifyRowHmac(record)).toBe(false);
  });

  it('returns false when verificationResult is tampered', () => {
    const record = makeRecord({ verificationResult: 'rejected' });
    expect(verifyRowHmac(record)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// recordEvidence
// ---------------------------------------------------------------------------

describe('recordEvidence', () => {
  function dbRow(overrides: Record<string, unknown> = {}) {
    const id = 'uuid-1';
    const recordType = 'indexer_event';
    const recordRef = 'evt-001';
    const sourceIdentity = 'contract:C...';
    const record = { eventId: 'evt-001', eventType: 'LoanRequested', ledger: 100, txHash: 'hash' };
    const evidenceDigest = computeEvidenceDigest(record);
    const ingestedAt = new Date('2026-01-01T00:00:00.000Z');
    const verificationResult = 'verified';
    const rowHmac = computeRowHmac(
      id, recordType, recordRef, sourceIdentity, evidenceDigest,
      ingestedAt.toISOString(), verificationResult,
    );

    return {
      id,
      record_type: recordType,
      record_ref: recordRef,
      source_identity: sourceIdentity,
      evidence_digest: evidenceDigest,
      digest_algorithm: 'sha256',
      ingested_at: ingestedAt,
      verification_result: verificationResult,
      verification_detail: '{}',
      signing_key_id: 'default-internal-key-v1',
      row_hmac: rowHmac,
      ...overrides,
    };
  }

  it('inserts a row with a SHA-256 digest and returns the evidence record', async () => {
    const row = dbRow();
    mockQuery.mockResolvedValueOnce({ rows: [row], rowCount: 1 });

    const result = await recordEvidence({
      recordType: 'indexer_event',
      recordRef: 'evt-001',
      sourceIdentity: 'contract:C...',
      record: { eventId: 'evt-001', eventType: 'LoanRequested', ledger: 100, txHash: 'hash' },
      verificationResult: 'verified',
      verificationDetail: { ledger: 100 },
    });

    expect(result.id).toBe('uuid-1');
    expect(result.verificationResult).toBe('verified');

    // The INSERT SQL must NOT contain the raw record string
    const insertSql = mockQuery.mock.calls[0]![0] as string;
    expect(insertSql).toContain('INSERT INTO evidence_provenance');
    // The record content must NOT appear as a raw string in the params
    const params = mockQuery.mock.calls[0]![1] as unknown[];
    const paramStrings = params.map(String);
    expect(paramStrings.some((s) => s.includes('LoanRequested'))).toBe(false);
  });

  it('returns existing row on duplicate (record_type, record_ref, evidence_digest)', async () => {
    const row = dbRow();
    const pgDup = Object.assign(new Error('dup'), { code: '23505' });
    mockQuery
      .mockRejectedValueOnce(pgDup)
      .mockResolvedValueOnce({ rows: [row], rowCount: 1 });

    const result = await recordEvidence({
      recordType: 'indexer_event',
      recordRef: 'evt-001',
      sourceIdentity: 'contract:C...',
      record: { eventId: 'evt-001', eventType: 'LoanRequested', ledger: 100, txHash: 'hash' },
      verificationResult: 'verified',
    });

    expect(result.id).toBe('uuid-1');
  });

  it('rejects an unsupported record_type', async () => {
    await expect(
      recordEvidence({
        recordType: 'hack_the_planet' as never,
        recordRef: 'ref',
        sourceIdentity: 'src',
        record: {},
        verificationResult: 'verified',
      }),
    ).rejects.toThrow('Unsupported evidence record type');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('rejects an invalid verification_result', async () => {
    await expect(
      recordEvidence({
        recordType: 'indexer_event',
        recordRef: 'ref',
        sourceIdentity: 'src',
        record: {},
        verificationResult: 'maybe' as never,
      }),
    ).rejects.toThrow('Invalid verification_result');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('rejects an empty record_ref', async () => {
    await expect(
      recordEvidence({
        recordType: 'indexer_event',
        recordRef: '',
        sourceIdentity: 'src',
        record: {},
        verificationResult: 'verified',
      }),
    ).rejects.toThrow('record_ref is required');
  });

  it('rejects an empty source_identity', async () => {
    await expect(
      recordEvidence({
        recordType: 'indexer_event',
        recordRef: 'ref',
        sourceIdentity: '',
        record: {},
        verificationResult: 'verified',
      }),
    ).rejects.toThrow('source_identity is required');
  });

  it('rejects a null record object', async () => {
    await expect(
      recordEvidence({
        recordType: 'indexer_event',
        recordRef: 'ref',
        sourceIdentity: 'src',
        record: null as never,
        verificationResult: 'verified',
      }),
    ).rejects.toThrow('record is required');
  });

  it('propagates unexpected DB errors', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection lost'));
    await expect(
      recordEvidence({
        recordType: 'indexer_event',
        recordRef: 'ref',
        sourceIdentity: 'src',
        record: {},
        verificationResult: 'verified',
      }),
    ).rejects.toThrow('connection lost');
  });

  it('enumerates all record types and verification results', () => {
    expect(EVIDENCE_RECORD_TYPES).toContain('indexer_event');
    expect(EVIDENCE_RECORD_TYPES).toContain('quarantine_event');
    expect(VERIFICATION_RESULTS).toContain('verified');
    expect(VERIFICATION_RESULTS).toContain('quarantined');
  });
});

// ---------------------------------------------------------------------------
// getEvidence
// ---------------------------------------------------------------------------

describe('getEvidence', () => {
  it('returns the record when found', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'e1', record_type: 'indexer_event', record_ref: 'r1',
        source_identity: 'src', evidence_digest: 'd1', digest_algorithm: 'sha256',
        ingested_at: new Date().toISOString(), verification_result: 'verified',
        verification_detail: '{}', signing_key_id: 'k1', row_hmac: 'a'.repeat(64),
      }],
    });
    const result = await getEvidence('e1');
    expect(result.id).toBe('e1');
  });

  it('throws 404 when not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(getEvidence('nonexistent')).rejects.toThrow('not found');
  });
});

// ---------------------------------------------------------------------------
// findEvidence
// ---------------------------------------------------------------------------

describe('findEvidence', () => {
  it('returns the most recent matching record', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'e2', record_type: 'indexer_event', record_ref: 'r1',
        source_identity: 'src', evidence_digest: 'd1', digest_algorithm: 'sha256',
        ingested_at: new Date().toISOString(), verification_result: 'verified',
        verification_detail: '{}', signing_key_id: 'k1', row_hmac: 'b'.repeat(64),
      }],
    });
    const result = await findEvidence('indexer_event', 'r1');
    expect(result).not.toBeNull();
    expect(result!.id).toBe('e2');
  });

  it('returns null when no record matches', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await findEvidence('indexer_event', 'nonexistent');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listEvidence
// ---------------------------------------------------------------------------

describe('listEvidence', () => {
  it('returns an empty array when no records exist', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await listEvidence();
    expect(result).toHaveLength(0);
  });

  it('applies record_type filter', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await listEvidence({ recordType: 'quarantine_event' });
    const sql = mockQuery.mock.calls[0]![0] as string;
    expect(sql).toContain('record_type = $');
  });

  it('applies source_identity filter', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await listEvidence({ sourceIdentity: 'contract:C...' });
    const sql = mockQuery.mock.calls[0]![0] as string;
    expect(sql).toContain('source_identity = $');
  });

  it('applies verification_result filter', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await listEvidence({ verificationResult: 'rejected' });
    const sql = mockQuery.mock.calls[0]![0] as string;
    expect(sql).toContain('verification_result = $');
  });

  it('applies keyset cursor', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await listEvidence({ cursor: '2026-01-01T00:00:00.000Z' });
    const sql = mockQuery.mock.calls[0]![0] as string;
    expect(sql).toContain('ingested_at < $');
  });

  it('caps limit at 200', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await listEvidence({ limit: 9999 });
    const params = mockQuery.mock.calls[0]![1] as unknown[];
    expect(params[params.length - 1]).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// verifyEvidence
// ---------------------------------------------------------------------------

describe('verifyEvidence', () => {
  it('returns true for an untampered record', async () => {
    const id = 'e1';
    const recordType = 'indexer_event';
    const recordRef = 'r1';
    const sourceIdentity = 'src';
    const evidenceDigest = 'd1';
    const ingestedAt = new Date('2026-01-01T00:00:00.000Z');
    const verificationResult = 'verified';
    const rowHmac = computeRowHmac(
      id, recordType, recordRef, sourceIdentity, evidenceDigest,
      ingestedAt.toISOString(), verificationResult,
    );

    mockQuery.mockResolvedValueOnce({
      rows: [{
        id, record_type: recordType, record_ref: recordRef,
        source_identity: sourceIdentity, evidence_digest: evidenceDigest,
        digest_algorithm: 'sha256', ingested_at: ingestedAt,
        verification_result: verificationResult, verification_detail: '{}',
        signing_key_id: 'k1', row_hmac: rowHmac,
      }],
    });

    const isValid = await verifyEvidence(id);
    expect(isValid).toBe(true);
  });

  it('returns false for a tampered record', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'e1', record_type: 'indexer_event', record_ref: 'r1',
        source_identity: 'src', evidence_digest: 'd1', digest_algorithm: 'sha256',
        ingested_at: new Date('2026-01-01T00:00:00.000Z'),
        verification_result: 'verified', verification_detail: '{}',
        signing_key_id: 'k1', row_hmac: '0'.repeat(64),  // wrong HMAC
      }],
    });
    const isValid = await verifyEvidence('e1');
    expect(isValid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// No raw payload stored — disclosure guarantee
// ---------------------------------------------------------------------------

describe('disclosure guarantee — no raw payload in evidence table', () => {
  it('the INSERT params never contain the raw record as a string', async () => {
    const sensitivePayload = {
      borrower: 'GSECRET123',
      amount: '9999999999',
      privateKey: 'SUPERSECRET',
    };

    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'uuid', record_type: 'indexer_event', record_ref: 'r',
        source_identity: 'src', evidence_digest: computeEvidenceDigest(sensitivePayload),
        digest_algorithm: 'sha256', ingested_at: new Date(),
        verification_result: 'verified', verification_detail: '{}',
        signing_key_id: 'k', row_hmac: 'a'.repeat(64),
      }],
    });

    await recordEvidence({
      recordType: 'indexer_event',
      recordRef: 'r',
      sourceIdentity: 'src',
      record: sensitivePayload,
      verificationResult: 'verified',
    });

    const params = mockQuery.mock.calls[0]![1] as unknown[];
    const allParams = params.map((p) => (typeof p === 'string' ? p : ''));
    // The sensitive fields must NOT appear as plaintext in any parameter
    expect(allParams.some((s) => s.includes('GSECRET123'))).toBe(false);
    expect(allParams.some((s) => s.includes('SUPERSECRET'))).toBe(false);
    expect(allParams.some((s) => s.includes('9999999999'))).toBe(false);
  });
});
