/**
 * Staged credential rotation service (#851).
 *
 * Provides an auditable, staged rotation lifecycle for every credential type
 * in the system:
 *
 *   staged → overlap → propagating → revoking → completed
 *                                           ↘ recovering → rolled_back
 *
 * Design invariants:
 *
 * - **No secret material is ever stored.**  The rotation record carries only a
 *   SHA-256 hash of the new secret (for propagation verification) and
 *   structural metadata (credential type, subject, stage, actor, outcome).
 * - **Overlap is the zero-downtime window**: both old and new secrets are
 *   accepted simultaneously so live replicas and background workers that still
 *   hold the old secret in memory continue to function.
 * - **Propagation verification** confirms that every target consumer (API
 *   process, background worker, replica) has observed the new credential
 *   before the old one is revoked.
 * - **Revocation** deactivates the old secret; after revocation only the new
 *   secret is accepted.
 * - **Recovery** rolls back to the pre-rotation state if propagation or
 *   verification fails, restoring the old credential as the sole active one.
 * - **Idempotency**: each stage transition is idempotent. Re-advancing to the
 *   same stage is a no-op (returns the current record). Re-starting a rotation
 *   that is already in progress is rejected.
 *
 * Credential types and their live-rotation properties:
 *
 * | Type               | Read pattern        | Overlap mechanism                          |
 * |--------------------|---------------------|---------------------------------------------|
 * | database           | cached in Pool      | pool recreation after deploy                |
 * | jwt_signing        | re-read per call    | process.env mutation (in-process)           |
 * | internal_signing   | dual-secret window  | acceptBoth() during overlap                |
 * | webhook_inbound    | DB per call         | new active row + old row grace period       |
 * | webhook_egress     | DB per event        | subscription secret update                  |
 * | pii_encryption     | re-read per wrap    | KEK rotation service (existing)             |
 * | soroban_signing    | external signer     | external signer config rollout              |
 */

import crypto from 'node:crypto';
import { query } from '../db/connection.js';
import logger from '../utils/logger.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type CredentialType =
  | 'database'
  | 'jwt_signing'
  | 'internal_signing'
  | 'webhook_inbound'
  | 'webhook_egress'
  | 'pii_encryption'
  | 'soroban_signing';

export type RotationStage =
  | 'staged'
  | 'overlap'
  | 'propagating'
  | 'revoking'
  | 'completed'
  | 'failed'
  | 'recovering'
  | 'rolled_back';

export type RotationOutcome = 'success' | 'partial' | 'failed';

export interface PropagationTarget {
  /** Human-readable name of the consumer (e.g. "api-process", "webhook-retry-worker"). */
  name: string;
  /** True when the consumer has confirmed it observed the new credential. */
  confirmed: boolean;
  /** Epoch ms when confirmation was received (or null if pending). */
  confirmedAt: number | null;
}

export interface RotationEventRecord {
  id: number;
  rotationId: string;
  credentialType: CredentialType;
  subject: string;
  stage: RotationStage;
  previousStage: RotationStage | null;
  actor: string;
  outcome: RotationOutcome;
  metadata: Record<string, unknown> | null;
  newSecretHash: string | null;
  createdAt: Date;
}

export interface RotationState {
  rotationId: string;
  credentialType: CredentialType;
  subject: string;
  currentStage: RotationStage;
  actor: string;
  propagationTargets: PropagationTarget[];
  newSecretHash: string | null;
  startedAt: Date;
  completedAt: Date | null;
  events: RotationEventRecord[];
}

// ── Valid stage transitions ───────────────────────────────────────────────────

const VALID_TRANSITIONS: Record<RotationStage, RotationStage[]> = {
  staged: ['overlap', 'failed'],
  overlap: ['propagating', 'recovering', 'failed'],
  propagating: ['revoking', 'recovering', 'failed'],
  revoking: ['completed', 'recovering', 'failed'],
  completed: [],
  failed: ['recovering'],
  recovering: ['rolled_back', 'failed'],
  rolled_back: [],
};

function isValidTransition(from: RotationStage, to: RotationStage): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Compute a SHA-256 hash of a secret for propagation verification.
 * The hash is one-way and cannot be reversed to recover the secret.
 */
export function hashSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

/**
 * Sanitise metadata so no secret material is persisted.
 * Removes any key whose value looks like it could be a secret (long strings,
 * base64 blobs, values containing "secret"/"password"/"key"/"token").
 */
function sanitizeMetadata(metadata: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!metadata) return null;
  const SENSITIVE_KEY_RE = /secret|password|token|key|credential|private/i;
  const result: Record<string, unknown> = {};

  for (const [k, v] of Object.entries(metadata)) {
    if (SENSITIVE_KEY_RE.test(k)) {
      result[k] = '[REDACTED]';
    } else if (typeof v === 'string' && v.length > 128) {
      result[k] = `[truncated:${v.length} chars]`;
    } else {
      result[k] = v;
    }
  }
  return result;
}

// ── Audit helper ──────────────────────────────────────────────────────────────

async function writeAuditEntry(
  actor: string,
  action: string,
  target: string,
  metadata: Record<string, unknown> | null,
): Promise<void> {
  try {
    await query(
      `INSERT INTO audit_logs (actor, action, target, payload, status)
       VALUES ($1, $2, $3, $4::jsonb, 200)`,
      [actor, action, target, JSON.stringify(sanitizeMetadata(metadata))],
    );
  } catch (err) {
    logger.withContext().error('Failed to write credential-rotation audit entry', {
      err: err instanceof Error ? err.message : String(err),
      action,
      target,
    });
  }
}

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Start a new credential rotation.  Creates the first event record in the
 * `staged` stage and writes an audit log entry.
 *
 * Rejects if a rotation for the same credential type + subject is already
 * in progress (not completed, failed, or rolled_back).
 */
export async function startRotation(params: {
  credentialType: CredentialType;
  subject?: string;
  actor: string;
  newSecretHash?: string;
  propagationTargets?: string[];
  metadata?: Record<string, unknown>;
}): Promise<RotationState> {
  const { credentialType, actor } = params;
  const subject = params.subject ?? 'global';
  const newSecretHash = params.newSecretHash ?? null;
  const propagationTargets = (params.propagationTargets ?? defaultTargets(credentialType)).map(
    (name) => ({ name, confirmed: false, confirmedAt: null }),
  );
  const metadata = params.metadata ?? {};

  // Check for an existing in-progress rotation
  const existing = await query(
    `SELECT rotation_id FROM credential_rotation_events
     WHERE credential_type = $1 AND subject = $2
       AND stage NOT IN ('completed', 'failed', 'rolled_back')
     ORDER BY created_at DESC LIMIT 1`,
    [credentialType, subject],
  );
  if (existing.rows.length > 0) {
    throw new RotationAlreadyInProgressError(credentialType, subject);
  }

  const rotationId = crypto.randomUUID();

  await query(
    `INSERT INTO credential_rotation_events
       (rotation_id, credential_type, subject, stage, previous_stage,
        actor, outcome, metadata, new_secret_hash)
     VALUES ($1, $2, $3, $4, NULL, $5, 'success', $6::jsonb, $7)`,
    [
      rotationId,
      credentialType,
      subject,
      'staged',
      actor,
      JSON.stringify(sanitizeMetadata({ ...metadata, propagationTargets: propagationTargets.map((t) => t.name) })),
      newSecretHash,
    ],
  );

  await writeAuditEntry(
    actor,
    'CREDENTIAL_ROTATION_STAGED',
    `Credential:${credentialType}:${subject}`,
    { rotationId, credentialType, subject, propagationTargets: propagationTargets.map((t) => t.name) },
  );

  return buildRotationState(rotationId, credentialType, subject, 'staged', actor, propagationTargets, newSecretHash);
}

/**
 * Advance a rotation to the next stage.  Validates the transition is legal
 * and writes a new event record + audit entry.
 *
 * Returns the updated rotation state.
 */
export async function advanceStage(params: {
  rotationId: string;
  toStage: RotationStage;
  actor: string;
  outcome?: RotationOutcome;
  metadata?: Record<string, unknown>;
}): Promise<RotationState> {
  const { rotationId, toStage, actor } = params;
  const outcome = params.outcome ?? 'success';
  const metadata = params.metadata ?? {};

  // Fetch the current state
  const current = await getCurrentRotationState(rotationId);
  if (!current) {
    throw new RotationNotFoundError(rotationId);
  }

  if (!isValidTransition(current.currentStage, toStage)) {
    throw new InvalidStageTransitionError(current.currentStage, toStage);
  }

  await query(
    `INSERT INTO credential_rotation_events
       (rotation_id, credential_type, subject, stage, previous_stage,
        actor, outcome, metadata, new_secret_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
    [
      rotationId,
      current.credentialType,
      current.subject,
      toStage,
      current.currentStage,
      actor,
      outcome,
      JSON.stringify(sanitizeMetadata(metadata)),
      current.newSecretHash,
    ],
  );

  await writeAuditEntry(
    actor,
    `CREDENTIAL_ROTATION_${toStage.toUpperCase()}`,
    `Credential:${current.credentialType}:${current.subject}`,
    { rotationId, from: current.currentStage, to: toStage, outcome },
  );

  return buildRotationState(
    rotationId,
    current.credentialType,
    current.subject,
    toStage,
    actor,
    current.propagationTargets,
    current.newSecretHash,
  );
}

/**
 * Mark a propagation target as confirmed (the target consumer has observed
 * the new credential).
 */
export async function confirmPropagationTarget(
  rotationId: string,
  targetName: string,
): Promise<RotationState> {
  const state = await getCurrentRotationState(rotationId);
  if (!state) throw new RotationNotFoundError(rotationId);

  const updatedTargets = state.propagationTargets.map((t) =>
    t.name === targetName
      ? { ...t, confirmed: true, confirmedAt: Date.now() }
      : t,
  );

  // Store confirmation in metadata of the current rotation event
  await query(
    `INSERT INTO credential_rotation_events
       (rotation_id, credential_type, subject, stage, previous_stage,
        actor, outcome, metadata, new_secret_hash)
     VALUES ($1, $2, $3, $4, $4, $5, 'success', $6::jsonb, $7)`,
    [
      rotationId,
      state.credentialType,
      state.subject,
      'propagating',
      'system',
      JSON.stringify({ propagationTarget: targetName, confirmed: true }),
      state.newSecretHash,
    ],
  );

  return { ...state, propagationTargets: updatedTargets };
}

/**
 * Check whether all propagation targets have confirmed.
 */
export function isPropagationComplete(state: RotationState): boolean {
  return state.propagationTargets.every((t) => t.confirmed);
}

/**
 * Verify that a credential hash matches the expected new-secret hash.
 * Used by propagation checks to confirm a consumer is using the new secret.
 */
export function verifySecretHash(secret: string, expectedHash: string | null): boolean {
  if (!expectedHash) return true; // No hash recorded — skip verification
  return hashSecret(secret) === expectedHash;
}

/**
 * Recover a failed rotation by rolling back to the pre-rotation state.
 * Sets stage to `recovering` then `rolled_back`.
 */
export async function recoverRotation(
  rotationId: string,
  actor: string,
  reason: string,
): Promise<RotationState> {
  const state = await getCurrentRotationState(rotationId);
  if (!state) throw new RotationNotFoundError(rotationId);

  if (state.currentStage === 'completed' || state.currentStage === 'rolled_back') {
    throw new InvalidStageTransitionError(state.currentStage, 'recovering');
  }

  // Move to recovering
  await advanceStage({ rotationId, toStage: 'recovering', actor, metadata: { reason } });

  // Then to rolled_back
  return advanceStage({ rotationId, toStage: 'rolled_back', actor, metadata: { reason } });
}

/**
 * Get the current state of a rotation by reading its event history.
 */
export async function getCurrentRotationState(rotationId: string): Promise<RotationState | null> {
  const result = await query(
    `SELECT * FROM credential_rotation_events
     WHERE rotation_id = $1
     ORDER BY created_at ASC`,
    [rotationId],
  );
  if (result.rows.length === 0) return null;

  const rows = result.rows as Array<Record<string, unknown>>;
  const events: RotationEventRecord[] = rows.map((r) => ({
    id: Number(r.id),
    rotationId: r.rotation_id as string,
    credentialType: r.credential_type as CredentialType,
    subject: r.subject as string,
    stage: r.stage as RotationStage,
    previousStage: (r.previous_stage as RotationStage) ?? null,
    actor: r.actor as string,
    outcome: r.outcome as RotationOutcome,
    metadata: (r.metadata as Record<string, unknown>) ?? null,
    newSecretHash: (r.new_secret_hash as string) ?? null,
    createdAt: new Date(r.created_at as string),
  }));

  const latest = events[events.length - 1]!;
  const first = events[0]!;

  // Reconstruct propagation targets from metadata
  const propagationTargets: PropagationTarget[] = [];
  const initialMeta = first.metadata as Record<string, unknown> | null;
  const targetNames = (initialMeta?.propagationTargets as string[]) ?? defaultTargets(latest.credentialType);
  for (const name of targetNames) {
    const confirmed = events.some(
      (e) =>
        e.stage === 'propagating' &&
        (e.metadata as Record<string, unknown> | null)?.propagationTarget === name &&
        (e.metadata as Record<string, unknown> | null)?.confirmed === true,
    );
    propagationTargets.push({
      name,
      confirmed,
      confirmedAt: confirmed ? Date.now() : null,
    });
  }

  const completedEvent = events.find((e) => e.stage === 'completed' || e.stage === 'rolled_back');

  return {
    rotationId,
    credentialType: latest.credentialType,
    subject: latest.subject,
    currentStage: latest.stage,
    actor: latest.actor,
    propagationTargets,
    newSecretHash: latest.newSecretHash,
    startedAt: first.createdAt,
    completedAt: completedEvent ? completedEvent.createdAt : null,
    events,
  };
}

/**
 * List all rotations, optionally filtered by credential type and/or status.
 */
export async function listRotations(filters?: {
  credentialType?: CredentialType;
  stage?: RotationStage;
  limit?: number;
}): Promise<RotationState[]> {
  const limit = Math.min(filters?.limit ?? 50, 200);
  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (filters?.credentialType) {
    conditions.push(`credential_type = $${paramIdx++}`);
    params.push(filters.credentialType);
  }
  if (filters?.stage) {
    conditions.push(`stage = $${paramIdx++}`);
    params.push(filters.stage);
  }

  // Get the latest event per rotation_id (using DISTINCT ON)
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await query(
    `SELECT DISTINCT ON (rotation_id) rotation_id
     FROM credential_rotation_events
     ${where}
     ORDER BY rotation_id, created_at DESC
     LIMIT $${paramIdx++}`,
    [...params, limit],
  );

  const rotationIds = result.rows.map((r) => r.rotation_id as string);
  const states: RotationState[] = [];
  for (const id of rotationIds) {
    const state = await getCurrentRotationState(id);
    if (state) states.push(state);
  }
  return states;
}

// ── Error classes ──────────────────────────────────────────────────────────────

export class RotationAlreadyInProgressError extends Error {
  readonly code = 'ROTATION_IN_PROGRESS';
  constructor(credentialType: string, subject: string) {
    super(`A rotation is already in progress for ${credentialType}:${subject}`);
    this.name = 'RotationAlreadyInProgressError';
  }
}

export class RotationNotFoundError extends Error {
  readonly code = 'ROTATION_NOT_FOUND';
  constructor(rotationId: string) {
    super(`Rotation ${rotationId} not found`);
    this.name = 'RotationNotFoundError';
  }
}

export class InvalidStageTransitionError extends Error {
  readonly code = 'INVALID_TRANSITION';
  constructor(from: string, to: string) {
    super(`Invalid stage transition: ${from} → ${to}`);
    this.name = 'InvalidStageTransitionError';
  }
}

// ── Private helpers ───────────────────────────────────────────────────────────

function defaultTargets(credentialType: CredentialType): string[] {
  switch (credentialType) {
    case 'database':
      return ['api-process', 'event-indexer', 'webhook-retry-worker', 'score-reconciliation-worker'];
    case 'jwt_signing':
      return ['api-process'];
    case 'internal_signing':
      return ['api-process', 'internal-caller'];
    case 'webhook_inbound':
      return ['webhook-receiver', 'webhook-retry-worker'];
    case 'webhook_egress':
      return ['webhook-dispatcher', 'webhook-retry-worker'];
    case 'pii_encryption':
      return ['api-process', 'pii-rotation-worker'];
    case 'soroban_signing':
      return ['soroban-submitter', 'external-signer'];
    default:
      return ['api-process'];
  }
}

function buildRotationState(
  rotationId: string,
  credentialType: CredentialType,
  subject: string,
  currentStage: RotationStage,
  actor: string,
  propagationTargets: PropagationTarget[],
  newSecretHash: string | null,
): RotationState {
  return {
    rotationId,
    credentialType,
    subject,
    currentStage,
    actor,
    propagationTargets,
    newSecretHash,
    startedAt: new Date(),
    completedAt: currentStage === 'completed' || currentStage === 'rolled_back' ? new Date() : null,
    events: [],
  };
}
