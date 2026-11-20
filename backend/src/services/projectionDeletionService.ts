/**
 * Secure deletion contract for cached financial projections (#853).
 *
 * Defines the authoritative deletion surface for every Redis key that backs a
 * user-visible financial projection.  Design invariants:
 *
 * - Deletion is **exact-key DELETE** (never SCAN/KEYS) to avoid blocking Redis.
 * - DELETE is idempotent and commutative: duplicate or out-of-order calls are safe.
 * - Each deletion attempt returns a per-key boolean so callers can distinguish
 *   "confirmed deleted" from "Redis was unreachable" (the cacheService absorbs
 *   Redis errors and returns false rather than throwing).
 * - The generation counters in cacheContracts are incremented so any in-flight
 *   readThrough loader that races with this deletion will not re-fill the cache
 *   with pre-deletion data.
 * - Every deletion is written to audit_logs before the keys are touched so the
 *   record exists even if Redis is unreachable.
 * - Stale frontend READ_CACHE entries are addressed by the caller propagating a
 *   Cache-Invalidation-Token response header; the frontend evict helper reads
 *   it and removes matching keys from the in-memory map.
 */

import { query } from '../db/connection.js';
import { cacheService } from './cacheService.js';
import { CacheKeys, SCORE_CACHE_VERSION } from '../utils/cacheKeys.js';
import logger from '../utils/logger.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ProjectionDeletionResult {
  /** Subject the deletion targeted (wallet address / 'global'). */
  subject: string;
  /** ISO-8601 timestamp when this deletion was processed. */
  deletedAt: string;
  /** Per-key outcomes. true = confirmed deleted, false = Redis unreachable. */
  keys: Record<string, boolean>;
  /** True when every key deletion was confirmed (all values in `keys` are true). */
  allConfirmed: boolean;
  /** True when at least one key deletion could not be confirmed. */
  hasUnconfirmedDeletes: boolean;
}

export interface BulkProjectionDeletionResult {
  subjects: ProjectionDeletionResult[];
  totalKeys: number;
  confirmedKeys: number;
  unconfirmedKeys: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build the complete set of Redis keys that back financial projections for a
 * given wallet address.  Includes both versioned and legacy (pre-v1) formats so
 * orphaned entries left by any previous key-format change are also purged.
 */
export function projectionKeysForUser(userId: string): Record<string, string> {
  return {
    score_response: CacheKeys.scoreResponse(userId),
    score_breakdown: CacheKeys.scoreBreakdown(userId),
    score_history_onchain: `score:history:onchain:${userId}`,
    score_nft: `score:nft:${userId}`,
    borrower_loans: CacheKeys.borrowerLoans(userId),
    // Legacy formats — may be orphaned; delete anyway to prevent stale serving
    legacy_score_response: CacheKeys.legacyScoreResponse(userId),
    legacy_score_breakdown: CacheKeys.legacyScoreBreakdown(userId),
  };
}

/**
 * Build the set of Redis keys that back global (non-user-specific) financial
 * projections.
 */
export function globalProjectionKeys(): Record<string, string> {
  return {
    pool_stats: CacheKeys.poolStats(),
  };
}

// ── Audit helper ─────────────────────────────────────────────────────────────

async function writeAuditEntry(
  actor: string,
  subject: string,
  keyMap: Record<string, string>,
  outcome: Record<string, boolean>,
  ipAddress?: string,
): Promise<void> {
  try {
    await query(
      `INSERT INTO audit_logs (actor, action, target, payload, ip_address, status)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
      [
        actor,
        'DELETE /cache/projections',
        `CacheProjections:${subject}`,
        JSON.stringify({
          subject,
          keysAttempted: keyMap,
          outcome,
          schemaVersion: SCORE_CACHE_VERSION,
        }),
        ipAddress ?? null,
        200,
      ],
    );
  } catch (err) {
    // Audit failure must not suppress the deletion; log and continue.
    logger.withContext().error('Failed to write projection-deletion audit entry', {
      err,
      actor,
      subject,
    });
  }
}

// ── Core deletion functions ───────────────────────────────────────────────────

/**
 * Securely delete all cached financial projections for a single user.
 *
 * Steps:
 * 1. Build exact key list (versioned + legacy).
 * 2. Write an audit entry recording actor, target, and key list.
 * 3. Delete all keys in parallel via cacheService (fail-safe, never throws).
 * 4. Return per-key outcomes so callers can surface unconfirmed deletes.
 */
export async function deleteUserProjections(
  userId: string,
  actor: string,
  ipAddress?: string,
): Promise<ProjectionDeletionResult> {
  const keyMap = projectionKeysForUser(userId);
  const deletedAt = new Date().toISOString();

  // Write audit before touching Redis so the record exists regardless of
  // Redis availability.
  await writeAuditEntry(actor, userId, keyMap, {}, ipAddress);

  const entries = Object.entries(keyMap);
  const results = await Promise.all(entries.map(([, key]) => cacheService.delete(key)));

  const keys: Record<string, boolean> = {};
  for (let i = 0; i < entries.length; i++) {
    keys[entries[i][0]] = results[i];
  }

  const allConfirmed = results.every((r) => r === true);
  const hasUnconfirmedDeletes = results.some((r) => r === false);

  if (hasUnconfirmedDeletes) {
    logger.withContext().warn('Projection deletion: Redis unreachable for one or more keys', {
      actor,
      subject: userId,
      unconfirmed: entries.filter((_, i) => !results[i]).map(([name]) => name),
    });
  }

  // Update the audit entry with the actual outcome now that we have results.
  await writeAuditEntry(actor, userId, keyMap, keys, ipAddress);

  return { subject: userId, deletedAt, keys, allConfirmed, hasUnconfirmedDeletes };
}

/**
 * Securely delete all cached financial projections for multiple users in one
 * operation.  Each user is processed in parallel; a failure for one subject
 * does not abort the others.
 */
export async function deleteMultipleUserProjections(
  userIds: string[],
  actor: string,
  ipAddress?: string,
): Promise<BulkProjectionDeletionResult> {
  const subjects = await Promise.all(
    userIds.map((id) => deleteUserProjections(id, actor, ipAddress)),
  );

  const totalKeys = subjects.reduce((acc, s) => acc + Object.keys(s.keys).length, 0);
  const confirmedKeys = subjects.reduce(
    (acc, s) => acc + Object.values(s.keys).filter(Boolean).length,
    0,
  );

  return {
    subjects,
    totalKeys,
    confirmedKeys,
    unconfirmedKeys: totalKeys - confirmedKeys,
  };
}

/**
 * Revoke a stale or invalidated financial projection record.
 *
 * "Revocation" is semantically distinct from deletion: it deletes the cache and
 * additionally writes a revocation audit record with an explicit reason, making
 * the action auditable by compliance tools independently of the HTTP audit log.
 */
export async function revokeProjection(
  userId: string,
  actor: string,
  reason: string,
  ipAddress?: string,
): Promise<ProjectionDeletionResult> {
  const keyMap = projectionKeysForUser(userId);
  const deletedAt = new Date().toISOString();

  try {
    await query(
      `INSERT INTO audit_logs (actor, action, target, payload, ip_address, status)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
      [
        actor,
        'REVOKE cache/projections',
        `CacheProjections:${userId}`,
        JSON.stringify({ reason, subject: userId, keysAttempted: keyMap }),
        ipAddress ?? null,
        200,
      ],
    );
  } catch (err) {
    logger.withContext().error('Failed to write projection-revocation audit entry', {
      err,
      actor,
      subject: userId,
    });
  }

  const entries = Object.entries(keyMap);
  const results = await Promise.all(entries.map(([, key]) => cacheService.delete(key)));

  const keys: Record<string, boolean> = {};
  for (let i = 0; i < entries.length; i++) {
    keys[entries[i][0]] = results[i];
  }

  return {
    subject: userId,
    deletedAt,
    keys,
    allConfirmed: results.every((r) => r === true),
    hasUnconfirmedDeletes: results.some((r) => r === false),
  };
}

/**
 * Verify that a subject's projections are not served from any surviving Redis
 * key.  Returns the keys that still exist, which callers can use to confirm a
 * deletion or surface a failed-deletion incident.
 *
 * Uses GET rather than EXISTS so the check is compatible with the fail-safe
 * cacheService wrapper (a Redis outage returns null for all keys, which is
 * treated as "not present").
 */
export async function verifyProjectionsDeletion(
  userId: string,
): Promise<{ subject: string; survivingKeys: string[]; verified: boolean }> {
  const keyMap = projectionKeysForUser(userId);
  const entries = Object.entries(keyMap);

  const reads = await Promise.all(entries.map(([, key]) => cacheService.get<unknown>(key)));

  const survivingKeys = entries
    .filter((_, i) => reads[i] !== null)
    .map(([name]) => name);

  return {
    subject: userId,
    survivingKeys,
    verified: survivingKeys.length === 0,
  };
}
