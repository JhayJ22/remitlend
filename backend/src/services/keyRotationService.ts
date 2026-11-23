import crypto from 'node:crypto';
import client from 'prom-client';
import { pool } from '../db/connection.js';
import logger from '../utils/logger.js';
import {
  type DataClass,
  DEFAULT_DATA_CLASS,
  resolveKek,
  isKekRevoked,
  KeyRevokedError,
} from './encryptionKeyDomains.js';

/**
 * Key Rotation Service
 *
 * Manages the rotation of Data Encryption Keys (DEKs) for a *single data class*
 * from one Key Encryption Key (KEK) to another (issue #846).
 *
 * Class scoping is the central security property: a rotation batch targets one
 * `data_class` and re-wraps only the DEKs of that class. DEKs (and ciphertext)
 * belonging to any other class are never read or written by the batch, so
 * rotating — or revoking — one class's KEK cannot decrypt, corrupt, or break
 * unrelated classes' data. Audit records live in their own `audit` class domain
 * and are never touched by a PII/financial/credential rotation.
 *
 * Reliability: rotation is resumable from a checkpoint, retried with backoff
 * for transient KMS failures, verifiable by GCM-decrypting a sample with the
 * new KEK, and rollable back by restoring the recorded `old_dek_wrapped`.
 */

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface KeyRotationBatchRecord {
  id: string;
  old_kek_id: string;
  new_kek_id: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'rolled_back';
  last_rotated_record_id: string | null;
  total_records_scanned: number;
  total_records_rotated: number;
  total_records_failed: number;
  initiated_by: string;
  initiated_at: Date;
  completed_at: Date | null;
  rolled_back_at: Date | null;
  failure_reason: string | null;
  last_error_code: string | null;
  verification_passed: boolean | null;
  verification_sample_size: number | null;
  verification_checked_at: Date | null;
  metadata: Record<string, unknown>;
  request_id: string;
  data_class: DataClass;
}

export interface EncryptedRecord {
  id: string;
  table_name: string;
  field_name: string;
  ciphertext: Buffer;
  gcm_nonce: Buffer;
  dek_wrapped: Buffer;
  dek_kek_id: string;
  data_class: DataClass;
}

export interface RotationVerificationResult {
  batch_id: string;
  passed: boolean;
  sample_size: number;
  verified_at: Date;
  records_verified: number;
  records_failed: number;
  failure_details: Array<{
    record_id: string;
    table_name: string;
    error: string;
  }>;
}

// ============================================================================
// Error Classes
// ============================================================================

export class KeyRotationError extends Error {
  public readonly code: string;
  public readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean = false) {
    super(message);
    this.name = 'KeyRotationError';
    this.code = code;
    this.retryable = retryable;
  }
}

export class KMSUnwrapError extends KeyRotationError {
  constructor(message: string, retryable: boolean = false) {
    super('KMS_UNWRAP_ERROR', message, retryable);
  }
}

export class KMSWrapError extends KeyRotationError {
  constructor(message: string, retryable: boolean = false) {
    super('KMS_WRAP_ERROR', message, retryable);
  }
}

export class DecryptionError extends KeyRotationError {
  constructor(message: string, retryable: boolean = false) {
    super('DECRYPTION_ERROR', message, retryable);
  }
}

export class RotationAlreadyInProgressError extends KeyRotationError {
  constructor(dataClass: DataClass) {
    super(
      'ROTATION_IN_PROGRESS',
      `Another key rotation is already in progress for class '${dataClass}'`,
      false,
    );
  }
}

// ============================================================================
// Metrics
// ============================================================================

const keyRotationMetrics = {
  batchStarted: new client.Counter({
    name: 'key_rotation_batch_started_total',
    help: 'Number of key rotation batches started',
    labelNames: ['old_kek_id', 'new_kek_id', 'data_class'],
  }),

  batchCompleted: new client.Counter({
    name: 'key_rotation_batch_completed_total',
    help: 'Number of key rotation batches completed',
    labelNames: ['batch_id', 'status'],
  }),

  batchDurationSeconds: new client.Histogram({
    name: 'key_rotation_batch_duration_seconds',
    help: 'Key rotation batch duration in seconds',
    labelNames: ['batch_id', 'status'],
    buckets: [1, 5, 10, 30, 60, 300, 600, 1800],
  }),

  recordsRotated: new client.Gauge({
    name: 'key_rotation_records_rotated',
    help: 'Number of records rotated in current batch',
    labelNames: ['batch_id'],
  }),

  recordsFailed: new client.Gauge({
    name: 'key_rotation_records_failed',
    help: 'Number of records failed during rotation',
    labelNames: ['batch_id'],
  }),

  kmsOperationDurationSeconds: new client.Histogram({
    name: 'key_rotation_kms_operation_duration_seconds',
    help: 'Duration of KMS encrypt/decrypt operations',
    labelNames: ['operation', 'kek_id', 'success'],
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
  }),

  verificationPassed: new client.Counter({
    name: 'key_rotation_verification_passed_total',
    help: 'Number of successful verifications',
    labelNames: ['batch_id', 'sample_size'],
  }),

  rollbackTriggered: new client.Counter({
    name: 'key_rotation_rollback_triggered_total',
    help: 'Number of rollbacks triggered',
    labelNames: ['batch_id', 'reason'],
  }),
};

// ============================================================================
// Configuration & Constants
// ============================================================================

const ROTATION_CONFIG = {
  MAX_RETRIES: 3,
  INITIAL_BACKOFF_MS: 500,
  MAX_BACKOFF_MS: 30000,
  BATCH_SIZE: 100,
  VERIFICATION_SAMPLE_SIZE: 50,
  KMS_TIMEOUT_MS: 5000,
};

// ============================================================================
// Key Rotation Service
// ============================================================================

export class KeyRotationService {
  /**
   * Start a new key rotation batch for a single data class.
   *
   * The batch re-wraps only the DEKs of `dataClass` whose current `dek_kek_id`
   * matches the class's resolved old KEK id. Records of any other class are
   * never scanned or written, preserving the key-separation invariant.
   */
  async startRotation(
    newKekId: string,
    actor: string,
    requestId: string,
    dataClass: DataClass = DEFAULT_DATA_CLASS,
  ): Promise<KeyRotationBatchRecord> {
    logger.info('key_rotation_start_requested', {
      new_kek_id: newKekId,
      data_class: dataClass,
      actor,
      request_id: requestId,
    });

    // Reject rotation *to* a revoked KEK (fail closed at submission).
    if (isKekRevoked(newKekId)) {
      throw new KeyRevokedError(newKekId);
    }

    // Only one in-progress rotation per class at a time.
    const existing = await pool.query(
      `SELECT id FROM key_rotation_batch WHERE status = 'in_progress' AND data_class = $1 LIMIT 1`,
      [dataClass],
    );
    if (existing.rows.length > 0) {
      throw new RotationAlreadyInProgressError(dataClass);
    }

    // Validate the new KEK is accessible.
    await this.validateKekAccess(newKekId);

    // Old KEK id is the class's currently-resolved KEK id.
    const currentKekId = resolveKek(dataClass).kekId;

    if (currentKekId === newKekId) {
      throw new KeyRotationError(
        'NOOP_ROTATION',
        `New KEK id equals current KEK id for class '${dataClass}'; nothing to rotate`,
        false,
      );
    }

    const batchId = crypto.randomUUID();
    const result = await pool.query(
      `INSERT INTO key_rotation_batch
       (id, old_kek_id, new_kek_id, status, initiated_by, initiated_at, request_id, metadata, data_class)
       VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7, $8)
       RETURNING *`,
      [
        batchId,
        currentKekId,
        newKekId,
        'pending',
        actor,
        requestId,
        JSON.stringify({ actor, timestamp: new Date().toISOString(), data_class: dataClass }),
        dataClass,
      ],
    );

    const batch = result.rows[0] as KeyRotationBatchRecord;

    keyRotationMetrics.batchStarted.labels(currentKekId, newKekId, dataClass).inc();

    logger.info('key_rotation_batch_created', {
      batch_id: batch.id,
      old_kek_id: batch.old_kek_id,
      new_kek_id: batch.new_kek_id,
      data_class: dataClass,
      request_id: requestId,
    });

    // Initiate rotation in background (non-blocking).
    this.executeRotation(batch.id, dataClass).catch((err) => {
      logger.error('key_rotation_background_error', {
        batch_id: batch.id,
        data_class: dataClass,
        error: err instanceof Error ? err.message : String(err),
        request_id: requestId,
      });
    });

    return batch;
  }

  /**
   * Resume a rotation from the last checkpoint.
   */
  async resumeRotation(batchId: string): Promise<KeyRotationBatchRecord> {
    logger.info('key_rotation_resume_requested', { batch_id: batchId });

    const result = await pool.query(`SELECT * FROM key_rotation_batch WHERE id = $1`, [batchId]);

    if (result.rows.length === 0) {
      throw new KeyRotationError('BATCH_NOT_FOUND', `Batch ${batchId} not found`, false);
    }

    const batch = result.rows[0] as KeyRotationBatchRecord;

    if (batch.status === 'completed') {
      throw new KeyRotationError('BATCH_ALREADY_COMPLETED', `Batch ${batchId} already completed`, false);
    }
    if (batch.status === 'rolled_back') {
      throw new KeyRotationError('BATCH_ROLLED_BACK', `Batch ${batchId} was rolled back`, false);
    }

    await pool.query(`UPDATE key_rotation_batch SET status = 'in_progress' WHERE id = $1`, [batchId]);

    this.executeRotation(batchId, batch.data_class).catch((err) => {
      logger.error('key_rotation_resume_error', {
        batch_id: batchId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return batch;
  }

  /**
   * Execute the rotation: scan encrypted records of the batch's class and
   * re-encrypt each DEK with the new KEK. Only `dataClass` rows are ever read
   * or written (class isolation).
   */
  private async executeRotation(batchId: string, dataClass: DataClass): Promise<void> {
    const startTime = Date.now();
    const client = await pool.connect();

    try {
      const batchResult = await client.query(`SELECT * FROM key_rotation_batch WHERE id = $1`, [batchId]);
      if (batchResult.rows.length === 0) {
        throw new KeyRotationError('BATCH_NOT_FOUND', `Batch ${batchId} not found`, false);
      }
      const batch = batchResult.rows[0] as KeyRotationBatchRecord;

      await client.query(`UPDATE key_rotation_batch SET status = 'in_progress' WHERE id = $1`, [batchId]);

      // Scan ONLY records of this class under the old KEK. The data_class
      // predicate is what guarantees other classes are never touched.
      const offset = batch.last_rotated_record_id ? 1 : 0;
      const scanResult = await client.query(
        `SELECT * FROM pii_encrypted_fields
         WHERE data_class = $1 AND dek_kek_id = $2
         ORDER BY created_at ASC
         LIMIT $3 OFFSET $4`,
        [dataClass, batch.old_kek_id, ROTATION_CONFIG.BATCH_SIZE, offset],
      );

      const records: EncryptedRecord[] = scanResult.rows;

      if (records.length === 0) {
        // Rotation complete for this class.
        const totals = await client.query(
          `SELECT total_records_failed FROM key_rotation_batch WHERE id = $1`,
          [batchId],
        );
        const failed = Number((totals.rows[0] as { total_records_failed: string }).total_records_failed ?? 0);
        if (failed > 0) {
          await client.query(
            `UPDATE key_rotation_batch SET status = 'failed', failure_reason = $1 WHERE id = $2`,
            [`${failed} records failed to rotate`, batchId],
          );
          keyRotationMetrics.batchDurationSeconds.labels(batchId, 'failed').observe((Date.now() - startTime) / 1000);
        } else {
          await client.query(
            `UPDATE key_rotation_batch SET status = 'completed', completed_at = NOW() WHERE id = $1`,
            [batchId],
          );
          keyRotationMetrics.batchDurationSeconds.labels(batchId, 'completed').observe((Date.now() - startTime) / 1000);
        }
        logger.info('key_rotation_completed', {
          batch_id: batchId,
          data_class: dataClass,
          total_records_rotated: batch.total_records_rotated,
          duration_seconds: (Date.now() - startTime) / 1000,
        });
        return;
      }

      let successCount = 0;
      let failureCount = 0;

      for (const record of records) {
        try {
          await this.rotateRecordWithRetry(record, batch, client);
          successCount++;
        } catch (err) {
          failureCount++;
          const errorMsg = err instanceof Error ? err.message : String(err);
          logger.error('key_rotation_record_failed', {
            batch_id: batchId,
            record_id: record.id,
            data_class: dataClass,
            error: errorMsg,
          });
          await client.query(
            `INSERT INTO key_rotation_record
             (id, batch_id, table_name, record_id, field_name, status, failure_reason, attempted_at, completed_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())`,
            [crypto.randomUUID(), batchId, record.table_name, record.id, record.field_name, 'failed', errorMsg],
          );
        }
      }

      await client.query(
        `UPDATE key_rotation_batch
         SET total_records_rotated = total_records_rotated + $1,
             total_records_failed = total_records_failed + $2,
             total_records_scanned = total_records_scanned + $3,
             last_rotated_record_id = $4,
             last_error_code = CASE WHEN $2 > 0 THEN 'PARTIAL_FAILURE' ELSE NULL END
         WHERE id = $5`,
        [successCount, failureCount, records.length, records[records.length - 1]!.id, batchId],
      );

      keyRotationMetrics.recordsRotated.labels(batchId).set(batch.total_records_rotated + successCount);
      keyRotationMetrics.recordsFailed.labels(batchId).set(failureCount);

      // Continue with the next batch if this one was full.
      if (records.length === ROTATION_CONFIG.BATCH_SIZE) {
        setImmediate(() => {
          this.executeRotation(batchId, dataClass).catch((err) => {
            logger.error('key_rotation_continue_error', {
              batch_id: batchId,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        });
      }
    } finally {
      client.release();
    }
  }

  /**
   * Rotate a single record's DEK from the batch's old KEK to its new KEK, with
   * retry + exponential backoff for transient KMS failures.
   *
   * Stores both `old_dek_wrapped` and `new_dek_wrapped` in the checkpoint row
   * so rollback can restore the prior wrapping without re-deriving it.
   */
  private async rotateRecordWithRetry(
    record: EncryptedRecord,
    batch: KeyRotationBatchRecord,
    client: { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
    attempt: number = 1,
  ): Promise<void> {
    try {
      // Decrypt the DEK with the OLD KEK (read-through; fails closed if old
      // KEK was revoked — rotation then refuses rather than silently skipping).
      const dek = await this.unwrapDekWithMetrics(record.dek_wrapped, batch.old_kek_id);

      // Re-wrap the DEK with the NEW KEK.
      const newDekWrapped = await this.wrapDekWithMetrics(dek, batch.new_kek_id);

      // Update only this class's record.
      await client.query(
        `UPDATE pii_encrypted_fields SET dek_wrapped = $1, dek_kek_id = $2, updated_at = NOW() WHERE id = $3`,
        [newDekWrapped, batch.new_kek_id, record.id],
      );

      // Checkpoint with both wrappings for rollback + a real batch_id.
      await client.query(
        `INSERT INTO key_rotation_record
         (id, batch_id, table_name, record_id, field_name, status, old_dek_wrapped, new_dek_wrapped, attempted_at, completed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())`,
        [
          crypto.randomUUID(),
          batch.id,
          record.table_name,
          record.id,
          record.field_name,
          'rotated',
          record.dek_wrapped,
          newDekWrapped,
        ],
      );
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const retryable =
        err instanceof KMSUnwrapError ||
        err instanceof KMSWrapError ||
        error.message.includes('timeout');

      if (retryable && attempt < ROTATION_CONFIG.MAX_RETRIES) {
        const backoffMs = Math.min(
          ROTATION_CONFIG.INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1),
          ROTATION_CONFIG.MAX_BACKOFF_MS,
        );
        logger.warn('key_rotation_record_retry', {
          record_id: record.id,
          attempt,
          backoff_ms: backoffMs,
          error: error.message,
        });
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        return this.rotateRecordWithRetry(record, batch, client, attempt + 1);
      }

      throw new KeyRotationError(
        'ROTATION_FAILED',
        `Failed to rotate record ${record.id}: ${error.message}`,
        false,
      );
    }
  }

  /**
   * Verify rotation by GCM-decrypting a sample of rotated records with the
   * new KEK. A successful GCM auth-tag check proves the new wrapped DEK
   * decrypts to the same DEK that still authenticates the stored ciphertext.
   */
  async verifyRotation(batchId: string): Promise<RotationVerificationResult> {
    logger.info('key_rotation_verify_started', { batch_id: batchId });

    const batchResult = await pool.query(`SELECT * FROM key_rotation_batch WHERE id = $1`, [batchId]);
    if (batchResult.rows.length === 0) {
      throw new KeyRotationError('BATCH_NOT_FOUND', `Batch ${batchId} not found`, false);
    }
    const batch = batchResult.rows[0] as KeyRotationBatchRecord;

    const checkResult = await pool.query(
      `SELECT r.*, f.ciphertext, f.gcm_nonce
         FROM key_rotation_record r
         JOIN pii_encrypted_fields f ON f.id = r.record_id
        WHERE r.batch_id = $1 AND r.status = 'rotated'
        ORDER BY RANDOM()
        LIMIT $2`,
      [batchId, ROTATION_CONFIG.VERIFICATION_SAMPLE_SIZE],
    );

    const records = checkResult.rows as Array<{
      id: string;
      record_id: string;
      table_name: string;
      new_dek_wrapped: Buffer;
      ciphertext: Buffer;
      gcm_nonce: Buffer;
    }>;

    const failures: Array<{ record_id: string; table_name: string; error: string }> = [];

    for (const rec of records) {
      try {
        const dek = await this.unwrapDekWithMetrics(rec.new_dek_wrapped, batch.new_kek_id);
        const authTag = rec.ciphertext.subarray(rec.ciphertext.length - 16);
        const encryptedData = rec.ciphertext.subarray(0, rec.ciphertext.length - 16);
        const decipher = crypto.createDecipheriv('aes-256-gcm', dek, rec.gcm_nonce);
        decipher.setAuthTag(authTag);
        decipher.update(encryptedData);
        decipher.final(); // throws if auth tag / key mismatch
      } catch (err) {
        failures.push({
          record_id: rec.record_id,
          table_name: rec.table_name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const passed = failures.length === 0;
    const result: RotationVerificationResult = {
      batch_id: batchId,
      passed,
      sample_size: records.length,
      verified_at: new Date(),
      records_verified: records.length - failures.length,
      records_failed: failures.length,
      failure_details: failures,
    };

    await pool.query(
      `UPDATE key_rotation_batch SET verification_passed = $1, verification_sample_size = $2, verification_checked_at = NOW() WHERE id = $3`,
      [passed, records.length, batchId],
    );

    if (passed) {
      keyRotationMetrics.verificationPassed.labels(batchId, String(records.length)).inc();
    }
    logger.info('key_rotation_verify_completed', {
      batch_id: batchId,
      passed,
      sample_size: records.length,
      failures: failures.length,
    });
    return result;
  }

  /**
   * Rollback rotation: restore each rotated record's `old_dek_wrapped` and
   * old `dek_kek_id`. This is a real restore (not a status flip) using the
   * wrappings recorded in `key_rotation_record` during rotation.
   */
  async rollbackRotation(batchId: string, reason: string): Promise<void> {
    logger.warn('key_rotation_rollback_requested', { batch_id: batchId, reason });

    const batchResult = await pool.query(`SELECT * FROM key_rotation_batch WHERE id = $1`, [batchId]);
    if (batchResult.rows.length === 0) {
      throw new KeyRotationError('BATCH_NOT_FOUND', `Batch ${batchId} not found`, false);
    }
    const batch = batchResult.rows[0] as KeyRotationBatchRecord;

    const recordsResult = await pool.query(
      `SELECT * FROM key_rotation_record WHERE batch_id = $1 AND status = 'rotated'`,
      [batchId],
    );
    const records = recordsResult.rows as Array<{
      id: string;
      record_id: string;
      old_dek_wrapped: Buffer;
    }>;

    let restored = 0;
    for (const rec of records) {
      try {
        if (!rec.old_dek_wrapped) {
          logger.warn('key_rotation_rollback_no_old_wrapping', { batch_id: batchId, record_id: rec.record_id });
          continue;
        }
        await pool.query(
          `UPDATE pii_encrypted_fields SET dek_wrapped = $1, dek_kek_id = $2, updated_at = NOW() WHERE id = $3`,
          [rec.old_dek_wrapped, batch.old_kek_id, rec.record_id],
        );
        await pool.query(`UPDATE key_rotation_record SET status = 'rolled_back' WHERE id = $1`, [rec.id]);
        restored++;
      } catch (err) {
        logger.error('key_rotation_rollback_failed', {
          batch_id: batchId,
          record_id: rec.record_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    await pool.query(
      `UPDATE key_rotation_batch SET status = 'rolled_back', rolled_back_at = NOW(), failure_reason = $1 WHERE id = $2`,
      [reason, batchId],
    );

    keyRotationMetrics.rollbackTriggered.labels(batchId, reason).inc();
    logger.info('key_rotation_rollback_completed', {
      batch_id: batchId,
      records_rolled_back: restored,
      reason,
    });
  }

  /**
   * Validate that a KEK is accessible (KMS mode) or configured (local mode).
   */
  private async validateKekAccess(kekId: string): Promise<void> {
    const kmsEndpoint = resolveKek(DEFAULT_DATA_CLASS).kmsEndpoint;
    if (!kmsEndpoint) {
      logger.info('key_rotation_validate_local_kek', { kek_id: kekId });
      return;
    }
    try {
      const response = (await Promise.race([
        fetch(`${kmsEndpoint}/validate-key`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kek_id: kekId }),
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('KMS timeout')), ROTATION_CONFIG.KMS_TIMEOUT_MS),
        ),
      ])) as Response;
      if (!response.ok) {
        throw new KeyRotationError('KMS_VALIDATION_FAILED', `KMS returned ${response.status}`, false);
      }
      logger.info('key_rotation_kek_validated', { kek_id: kekId });
    } catch (err) {
      throw new KeyRotationError(
        'KMS_ACCESS_DENIED',
        `Cannot validate KEK ${kekId}: ${err instanceof Error ? err.message : String(err)}`,
        false,
      );
    }
  }

  private async unwrapDekWithMetrics(dekWrapped: Buffer, kekId: string): Promise<Buffer> {
    const start = Date.now();
    try {
      const dek = await this.unwrapDek(dekWrapped, kekId);
      keyRotationMetrics.kmsOperationDurationSeconds.labels('unwrap', kekId, 'true').observe((Date.now() - start) / 1000);
      return dek;
    } catch (err) {
      keyRotationMetrics.kmsOperationDurationSeconds.labels('unwrap', kekId, 'false').observe((Date.now() - start) / 1000);
      throw err;
    }
  }

  private async wrapDekWithMetrics(dek: Buffer, kekId: string): Promise<Buffer> {
    const start = Date.now();
    try {
      const wrapped = await this.wrapDek(dek, kekId);
      keyRotationMetrics.kmsOperationDurationSeconds.labels('wrap', kekId, 'true').observe((Date.now() - start) / 1000);
      return wrapped;
    } catch (err) {
      keyRotationMetrics.kmsOperationDurationSeconds.labels('wrap', kekId, 'false').observe((Date.now() - start) / 1000);
      throw err;
    }
  }

  private async unwrapDek(dekWrapped: Buffer, kekId: string): Promise<Buffer> {
    if (isKekRevoked(kekId)) {
      throw new KeyRevokedError(kekId);
    }
    const kmsEndpoint = resolveKek(DEFAULT_DATA_CLASS).kmsEndpoint;
    if (kmsEndpoint) {
      try {
        const response = (await Promise.race([
          fetch(`${kmsEndpoint}/decrypt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kek_id: kekId, wrapped_key: dekWrapped.toString('base64') }),
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('KMS timeout')), ROTATION_CONFIG.KMS_TIMEOUT_MS),
          ),
        ])) as Response;
        if (!response.ok) {
          throw new KMSUnwrapError(`KMS returned ${response.status}`, response.status === 408 || response.status >= 500);
        }
        const { plaintext } = (await response.json()) as { plaintext: string };
        return Buffer.from(plaintext, 'base64');
      } catch (err) {
        // Preserve an already-typed KMS error (and its retryable flag); only
        // re-wrap raw errors such as network/timeout failures.
        if (err instanceof KMSUnwrapError) throw err;
        throw new KMSUnwrapError(
          err instanceof Error ? err.message : String(err),
          err instanceof Error ? err.message.includes('timeout') : false,
        );
      }
    }
    return this.unwrapLocal(dekWrapped, kekId);
  }

  /**
   * Local-mode unwrap: try each class's configured KEK whose id matches kekId
   * until one authenticates. In single-KEK (legacy) mode all classes share one
   * key so the first attempt succeeds; in separated mode only the owning
   * class's key authenticates the wrapped DEK.
   */
  private unwrapLocal(dekWrapped: Buffer, kekId: string): Buffer {
    const iv = dekWrapped.subarray(0, 12);
    const tag = dekWrapped.subarray(12, 28);
    const encrypted = dekWrapped.subarray(28);
    const tried = new Set<string>();
    for (const cls of ['pii', 'financial', 'credential', 'audit'] as const) {
      const ctx = resolveKek(cls);
      if (ctx.kekId !== kekId) continue;
      const keyHex = ctx.kekKey.toString('hex');
      if (tried.has(keyHex)) continue;
      tried.add(keyHex);
      try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', ctx.kekKey, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(encrypted), decipher.final()]);
      } catch {
        // wrong key for this wrapped DEK; try next class
      }
    }
    throw new DecryptionError(`No configured KEK authenticates kek_id=${kekId}`, false);
  }

  private async wrapDek(dek: Buffer, kekId: string): Promise<Buffer> {
    if (isKekRevoked(kekId)) {
      throw new KeyRevokedError(kekId);
    }
    const kmsEndpoint = resolveKek(DEFAULT_DATA_CLASS).kmsEndpoint;
    if (kmsEndpoint) {
      try {
        const response = (await Promise.race([
          fetch(`${kmsEndpoint}/encrypt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kek_id: kekId, plaintext: dek.toString('base64') }),
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('KMS timeout')), ROTATION_CONFIG.KMS_TIMEOUT_MS),
          ),
        ])) as Response;
        if (!response.ok) {
          throw new KMSWrapError(`KMS returned ${response.status}`, response.status === 408 || response.status >= 500);
        }
        const { wrapped_key } = (await response.json()) as { wrapped_key: string };
        return Buffer.from(wrapped_key, 'base64');
      } catch (err) {
        // Preserve an already-typed KMS error (and its retryable flag).
        if (err instanceof KMSWrapError) throw err;
        throw new KMSWrapError(
          err instanceof Error ? err.message : String(err),
          err instanceof Error ? err.message.includes('timeout') : false,
        );
      }
    }
    // Local mode: wrap with the KEK material whose id == kekId. Prefer the
    // class-specific key; fall back to the first matching class.
    for (const cls of ['pii', 'financial', 'credential', 'audit'] as const) {
      const ctx = resolveKek(cls);
      if (ctx.kekId === kekId) {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', ctx.kekKey, iv);
        const encrypted = Buffer.concat([cipher.update(dek), cipher.final()]);
        return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
      }
    }
    throw new KMSWrapError(`No configured KEK matches kek_id=${kekId} for wrapping`, false);
  }
}

export const keyRotationService = new KeyRotationService();
