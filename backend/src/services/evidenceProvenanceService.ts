/**
 * Signed evidence provenance service (#848).
 *
 * Binds evidence digest, source identity, ingestion time, and verification
 * result in an integrity-protected audit record. Never copies the original
 * sensitive payload — only a SHA-256 digest and structured metadata are
 * stored.  Every row carries an HMAC-SHA256 over its own columns so that any
 * post-insert tampering can be detected by re-computing the MAC.
 *
 * The HMAC key is the same INTERNAL_SIGNING_SECRET used by the internal
 * request signing middleware — a single secret, managed via env var, that
 * can be rotated by changing the env and restarting the process.  The
 * `signing_key_id` column records which key produced the HMAC so that
 * verification against a rotated key is possible.
 */

import crypto from 'node:crypto';
import { query } from '../db/connection.js';
import { AppError } from '../errors/AppError.js';
import logger from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const EVIDENCE_RECORD_TYPES = [
  'indexer_event',
  'quarantine_event',
  'remittance_ingestion',
  'reconciliation_check',
  'webhook_delivery',
] as const;

export type EvidenceRecordType = (typeof EVIDENCE_RECORD_TYPES)[number];

export const VERIFICATION_RESULTS = [
  'verified',
  'provisional',
  'rejected',
  'quarantined',
] as const;

export type VerificationResult = (typeof VERIFICATION_RESULTS)[number];

const SIGNING_SECRET = process.env.INTERNAL_SIGNING_SECRET || 'default-dev-secret';
const SIGNING_KEY_ID = process.env.INTERNAL_SIGNING_KEY_ID || 'default-internal-key-v1';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EvidenceRecord {
  id: string;
  recordType: EvidenceRecordType;
  recordRef: string;
  sourceIdentity: string;
  evidenceDigest: string;
  digestAlgorithm: string;
  ingestedAt: Date;
  verificationResult: VerificationResult;
  verificationDetail: Record<string, unknown>;
  signingKeyId: string;
  rowHmac: string;
}

export interface RecordEvidenceInput {
  recordType: EvidenceRecordType;
  recordRef: string;
  sourceIdentity: string;
  /** The external record object — a SHA-256 digest is computed, never stored. */
  record: Record<string, unknown>;
  verificationResult: VerificationResult;
  /** Structured metadata (ledger, rule_version, error_code).  Never the raw payload. */
  verificationDetail?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Canonicalisation (deterministic JSON, keys sorted recursively)
// ---------------------------------------------------------------------------

/** Deterministic JSON: object keys sorted recursively, no extra whitespace. */
export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .filter((k) => obj[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** SHA-256 hex over the canonical JSON of `record`. */
export function computeEvidenceDigest(record: Record<string, unknown>): string {
  return crypto.createHash('sha256').update(canonicalize(record)).digest('hex');
}

// ---------------------------------------------------------------------------
// HMAC row binding
// ---------------------------------------------------------------------------

/**
 * Compute the HMAC-SHA256 over the pipe-joined columns of the row.
 * The `id` and `ingestedAt` are known at insert time so the HMAC can cover
 * them.  `ingestedAt` is formatted as an ISO-8601 string for determinism.
 */
export function computeRowHmac(
  id: string,
  recordType: string,
  recordRef: string,
  sourceIdentity: string,
  evidenceDigest: string,
  ingestedAtIso: string,
  verificationResult: string,
): string {
  const message = [
    id,
    recordType,
    recordRef,
    sourceIdentity,
    evidenceDigest,
    ingestedAtIso,
    verificationResult,
  ].join('|');
  return crypto.createHmac('sha256', SIGNING_SECRET).update(message).digest('hex');
}

/**
 * Verify a row's stored HMAC against a recomputed value.
 * Returns true when the row has not been tampered with after insert.
 */
export function verifyRowHmac(row: EvidenceRecord): boolean {
  const recomputed = computeRowHmac(
    row.id,
    row.recordType,
    row.recordRef,
    row.sourceIdentity,
    row.evidenceDigest,
    row.ingestedAt.toISOString(),
    row.verificationResult,
  );
  const stored = Buffer.from(row.rowHmac, 'hex');
  const computed = Buffer.from(recomputed, 'hex');
  return stored.length === computed.length && crypto.timingSafeEqual(stored, computed);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function assertValidRecordType(recordType: string): asserts recordType is EvidenceRecordType {
  if (!EVIDENCE_RECORD_TYPES.includes(recordType as EvidenceRecordType)) {
    throw AppError.badRequest(
      `Unsupported evidence record type: ${recordType}. Allowed: ${EVIDENCE_RECORD_TYPES.join(', ')}`,
    );
  }
}

function assertValidVerificationResult(
  result: string,
): asserts result is VerificationResult {
  if (!VERIFICATION_RESULTS.includes(result as VerificationResult)) {
    throw AppError.badRequest(
      `Invalid verification_result: ${result}. Allowed: ${VERIFICATION_RESULTS.join(', ')}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Row mapper
// ---------------------------------------------------------------------------

function rowToRecord(row: Record<string, unknown>): EvidenceRecord {
  return {
    id: row.id as string,
    recordType: row.record_type as EvidenceRecordType,
    recordRef: row.record_ref as string,
    sourceIdentity: row.source_identity as string,
    evidenceDigest: row.evidence_digest as string,
    digestAlgorithm: row.digest_algorithm as string,
    ingestedAt: new Date(row.ingested_at as string),
    verificationResult: row.verification_result as VerificationResult,
    verificationDetail:
      (row.verification_detail as Record<string, unknown>) ?? {},
    signingKeyId: row.signing_key_id as string,
    rowHmac: row.row_hmac as string,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Records a signed evidence provenance row for an externally supplied record.
 *
 * The original `record` object is NOT stored — only its SHA-256 digest.
 * Returns the immutable evidence record (including the row HMAC).
 *
 * Idempotent: a duplicate (record_type, record_ref, evidence_digest)
 * returns the existing row instead of failing.
 */
export async function recordEvidence(
  input: RecordEvidenceInput,
): Promise<EvidenceRecord> {
  assertValidRecordType(input.recordType);
  assertValidVerificationResult(input.verificationResult);

  if (!input.recordRef || input.recordRef.trim().length === 0) {
    throw AppError.badRequest('record_ref is required');
  }
  if (!input.sourceIdentity || input.sourceIdentity.trim().length === 0) {
    throw AppError.badRequest('source_identity is required');
  }
  if (!input.record || typeof input.record !== 'object') {
    throw AppError.badRequest('record is required and must be a non-null object');
  }

  const evidenceDigest = computeEvidenceDigest(input.record);
  const id = crypto.randomUUID();
  const ingestedAt = new Date();
  const ingestedAtIso = ingestedAt.toISOString();

  const rowHmac = computeRowHmac(
    id,
    input.recordType,
    input.recordRef,
    input.sourceIdentity,
    evidenceDigest,
    ingestedAtIso,
    input.verificationResult,
  );

  const detail = JSON.stringify(input.verificationDetail ?? {});

  try {
    const result = await query(
      `INSERT INTO evidence_provenance (
         id, record_type, record_ref, source_identity, evidence_digest,
         digest_algorithm, ingested_at, verification_result,
         verification_detail, signing_key_id, row_hmac
       ) VALUES ($1, $2, $3, $4, $5, 'sha256', $6, $7, $8::jsonb, $9, $10)
       RETURNING *`,
      [
        id,
        input.recordType,
        input.recordRef,
        input.sourceIdentity,
        evidenceDigest,
        ingestedAt,
        input.verificationResult,
        detail,
        SIGNING_KEY_ID,
        rowHmac,
      ],
    );

    const record = rowToRecord(result.rows[0] as Record<string, unknown>);

    logger.info('Evidence provenance recorded', {
      recordType: input.recordType,
      recordRef: input.recordRef,
      evidenceDigest: evidenceDigest.slice(0, 12) + '...',
      verificationResult: input.verificationResult,
    });

    return record;
  } catch (err: unknown) {
    const pgError = err as { code?: string };
    if (pgError.code === '23505') {
      // Duplicate (record_type, record_ref, evidence_digest) — return existing.
      const existing = await query(
        `SELECT * FROM evidence_provenance
         WHERE record_type = $1 AND record_ref = $2 AND evidence_digest = $3`,
        [input.recordType, input.recordRef, evidenceDigest],
      );
      if (existing.rows[0]) {
        return rowToRecord(existing.rows[0] as Record<string, unknown>);
      }
      throw AppError.conflict('Evidence record with this key already exists');
    }
    throw err;
  }
}

/**
 * Retrieves a single evidence record by id.
 */
export async function getEvidence(id: string): Promise<EvidenceRecord> {
  const result = await query(
    `SELECT * FROM evidence_provenance WHERE id = $1`,
    [id],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) throw AppError.notFound('Evidence record not found');
  return rowToRecord(row);
}

/**
 * Retrieves a single evidence record by (record_type, record_ref).
 * Returns the most recent matching row, or null if none exists.
 */
export async function findEvidence(
  recordType: EvidenceRecordType,
  recordRef: string,
): Promise<EvidenceRecord | null> {
  assertValidRecordType(recordType);
  const result = await query(
    `SELECT * FROM evidence_provenance
     WHERE record_type = $1 AND record_ref = $2
     ORDER BY ingested_at DESC LIMIT 1`,
    [recordType, recordRef],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  return row ? rowToRecord(row) : null;
}

/**
 * Lists evidence records with optional filters.
 * Keyset-paginated by `ingested_at DESC` using the cursor (ISO timestamp).
 */
export async function listEvidence(
  filters: {
    recordType?: EvidenceRecordType;
    sourceIdentity?: string;
    verificationResult?: VerificationResult;
    limit?: number;
    cursor?: string;
  } = {},
): Promise<EvidenceRecord[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (filters.recordType) {
    assertValidRecordType(filters.recordType);
    values.push(filters.recordType);
    conditions.push(`record_type = $${values.length}`);
  }
  if (filters.sourceIdentity) {
    values.push(filters.sourceIdentity);
    conditions.push(`source_identity = $${values.length}`);
  }
  if (filters.verificationResult) {
    assertValidVerificationResult(filters.verificationResult);
    values.push(filters.verificationResult);
    conditions.push(`verification_result = $${values.length}`);
  }
  if (filters.cursor) {
    values.push(filters.cursor);
    conditions.push(`ingested_at < $${values.length}`);
  }

  values.push(Math.min(filters.limit ?? 50, 200));
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const result = await query(
    `SELECT * FROM evidence_provenance ${where}
     ORDER BY ingested_at DESC LIMIT $${values.length}`,
    values,
  );

  return (result.rows as Array<Record<string, unknown>>).map(rowToRecord);
}

/**
 * Verifies the integrity of a stored evidence record by re-computing its HMAC.
 * Returns true when the row has not been tampered with since insertion.
 */
export async function verifyEvidence(id: string): Promise<boolean> {
  const record = await getEvidence(id);
  return verifyRowHmac(record);
}
