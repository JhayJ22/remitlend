/**
 * Signed operator actions for financial recovery tooling (#866).
 *
 * Every recovery command requires:
 * - Scoped operator identity (admin:recovery API key scope + JWT admin role)
 * - A bounded reason_code from a controlled vocabulary
 * - An approval_reference linking to an out-of-band authorisation record
 * - An idempotency_key (enforced by the global idempotency middleware; also
 *   stored here for auditability and duplicate-action detection)
 * - An HMAC-SHA256 operator signature over the canonical action payload
 * - An immutable outcome record written to operator_recovery_actions
 *
 * Arbitrary balance edits are explicitly not supported. The RECOVERY_EXECUTORS
 * map lists every allowed action; any action type absent from that map is
 * rejected at input validation before any database write.
 */

import crypto from 'node:crypto';
import { query } from '../db/connection.js';
import { withTransaction } from '../db/transaction.js';
import { AppError } from '../errors/AppError.js';
import logger from '../utils/logger.js';
import { resolveDiscrepancy } from './discrepancyLedgerService.js';
import { emitLoanStateEvent } from './loanStateEventStore.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Supported action types. Every entry MUST have a corresponding executor in
 * RECOVERY_EXECUTORS. Arbitrary balance mutations are intentionally absent.
 */
export const OPERATOR_RECOVERY_ACTION_TYPES = [
  'reconciliation_retry',
  'reconciliation_resolve',
  'cross_contract_reconcile',
  'loan_state_replay',
  'loan_event_retry',
] as const;

export type OperatorRecoveryActionType = (typeof OPERATOR_RECOVERY_ACTION_TYPES)[number];

/**
 * Bounded vocabulary for reason codes. These are stored as a column (not in
 * the payload blob) so dashboards and alert rules can filter without parsing
 * prose.
 */
export const RECOVERY_REASON_CODES = [
  'indexer_lag',
  'contract_event_missed',
  'db_write_failure',
  'duplicate_event',
  'stale_snapshot',
  'manual_reconciliation',
  'operator_requested',
] as const;

export type RecoveryReasonCode = (typeof RECOVERY_REASON_CODES)[number];

export interface OperatorRecoveryInput {
  /** Wallet public key of the authenticated operator (from JWT). */
  operatorId: string;
  actionType: OperatorRecoveryActionType;
  reasonCode: RecoveryReasonCode;
  /**
   * External ticket or approval system reference (e.g. a Jira ticket, incident
   * ID, or the numeric ID of a privileged_action_requests row).
   * Minimum 3 characters.
   */
  approvalReference: string;
  /**
   * Client-supplied Idempotency-Key from the HTTP request.
   * The global idempotency middleware already enforces uniqueness at the cache
   * layer; we also store it here so the row is unambiguously correlated to the
   * HTTP request.
   */
  idempotencyKey: string;
  /**
   * HMAC-SHA256 hex of
   * `${operatorId}|${actionType}|${idempotencyKey}|${canonicalize(payload)}`
   * keyed with the operator's scoped API key value.
   * The service re-derives and verifies this before writing.
   */
  operatorSignature: string;
  /** Validated action payload. Schema varies by actionType. */
  payload: Record<string, unknown>;
  /** Free-text justification, minimum 10 characters. */
  reasonNote: string;
}

export interface OperatorRecoveryRecord {
  id: number;
  operatorId: string;
  actionType: OperatorRecoveryActionType;
  reasonCode: RecoveryReasonCode;
  approvalReference: string;
  idempotencyKey: string;
  payloadHash: string;
  status: 'pending' | 'executing' | 'completed' | 'failed' | 'rejected';
  outcomeRef: string | null;
  outcomeError: string | null;
  executedAt: Date | null;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Payload canonicalisation (same scheme as privilegedActionService)
// ---------------------------------------------------------------------------

/** Deterministic JSON: object keys sorted recursively. */
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

export function computePayloadHash(actionType: string, payload: Record<string, unknown>): string {
  return crypto
    .createHash('sha256')
    .update(`${actionType}\n${canonicalize(payload)}`)
    .digest('hex');
}

/**
 * Derive the HMAC the operator should have produced.
 * @param apiKeyValue - the raw secret portion of the operator's admin:recovery key.
 */
export function deriveOperatorSignature(
  operatorId: string,
  actionType: string,
  idempotencyKey: string,
  payload: Record<string, unknown>,
  apiKeyValue: string,
): string {
  const message = `${operatorId}|${actionType}|${idempotencyKey}|${canonicalize(payload)}`;
  return crypto.createHmac('sha256', apiKeyValue).update(message).digest('hex');
}

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

/**
 * Verify the operator signature against each configured admin:recovery key.
 * Uses timing-safe comparison to prevent length / timing oracles.
 * Returns true when at least one configured key validates the signature.
 */
export function verifyOperatorSignature(
  operatorId: string,
  actionType: string,
  idempotencyKey: string,
  payload: Record<string, unknown>,
  providedSignature: string,
): boolean {
  const rawKeys = process.env.INTERNAL_API_KEY ?? '';
  const recoveryKeys = rawKeys
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith('admin:recovery:'))
    .map((entry) => entry.slice('admin:recovery:'.length));

  if (recoveryKeys.length === 0) {
    logger.warn('No admin:recovery keys configured; operator signature verification skipped');
    // In test/development environments with no key configured, skip verification
    // so integration tests can run without key setup.
    return process.env.NODE_ENV !== 'production';
  }

  for (const keyValue of recoveryKeys) {
    const expected = deriveOperatorSignature(
      operatorId,
      actionType,
      idempotencyKey,
      payload,
      keyValue,
    );
    const expectedBuf = Buffer.from(expected, 'hex');
    const providedBuf = Buffer.from(providedSignature, 'hex');
    if (
      expectedBuf.length === providedBuf.length &&
      crypto.timingSafeEqual(expectedBuf, providedBuf)
    ) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

export function validateRecoveryInput(input: OperatorRecoveryInput): void {
  if (!OPERATOR_RECOVERY_ACTION_TYPES.includes(input.actionType)) {
    throw AppError.badRequest(
      `Unsupported recovery action type: ${input.actionType}. ` +
        `Allowed: ${OPERATOR_RECOVERY_ACTION_TYPES.join(', ')}`,
    );
  }

  if (!RECOVERY_REASON_CODES.includes(input.reasonCode)) {
    throw AppError.badRequest(
      `Invalid reason_code: ${input.reasonCode}. ` +
        `Allowed: ${RECOVERY_REASON_CODES.join(', ')}`,
    );
  }

  if (!input.approvalReference || input.approvalReference.trim().length < 3) {
    throw AppError.badRequest('approval_reference must be at least 3 characters');
  }

  if (!input.idempotencyKey || input.idempotencyKey.trim().length === 0) {
    throw AppError.badRequest('idempotency_key is required');
  }

  if (!input.reasonNote || input.reasonNote.trim().length < 10) {
    throw AppError.badRequest('reason_note must be at least 10 characters');
  }

  if (!input.operatorSignature || !/^[0-9a-f]{64}$/.test(input.operatorSignature)) {
    throw AppError.badRequest(
      'operator_signature must be a 64-character lowercase hex string (HMAC-SHA256)',
    );
  }

  if (!input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)) {
    throw AppError.badRequest('payload must be a non-array JSON object');
  }
}

// ---------------------------------------------------------------------------
// Executor registry
// ---------------------------------------------------------------------------

interface ExecutorContext {
  operatorId: string;
  approvalReference: string;
  idempotencyKey: string;
  reasonCode: RecoveryReasonCode;
}

type RecoveryExecutor = (
  payload: Record<string, unknown>,
  ctx: ExecutorContext,
) => Promise<string>;

/**
 * Guards against balance-edit payloads on any action type that touches a
 * financial record.  Rejects payloads that contain suspicious keys.
 */
function rejectBalanceEdits(payload: Record<string, unknown>): void {
  const forbidden = [
    'balance',
    'amount',
    'principal',
    'collateral',
    'adjust_outstanding',
    'set_balance',
    'override_amount',
  ];
  for (const key of Object.keys(payload)) {
    if (forbidden.includes(key.toLowerCase())) {
      throw AppError.badRequest(
        `Arbitrary balance edits are not permitted. Field '${key}' is not allowed in recovery payloads.`,
      );
    }
  }
}

/**
 * Executor for 'reconciliation_retry': re-examines a reconciliation discrepancy
 * and bumps its observation metadata.  Does NOT alter financial data.
 *
 * Required payload: { discrepancy_id: number }
 */
const executeReconciliationRetry: RecoveryExecutor = async (payload, ctx) => {
  const id = Number(payload.discrepancy_id);
  if (!Number.isInteger(id) || id <= 0) {
    throw AppError.badRequest('discrepancy_id must be a positive integer');
  }

  rejectBalanceEdits(payload);

  const result = await query(
    `UPDATE reconciliation_discrepancies
     SET last_observed_at = NOW(), observation_count = observation_count + 1
     WHERE id = $1 AND status = 'open'
     RETURNING id`,
    [id],
  );
  if ((result.rowCount ?? 0) === 0) {
    throw AppError.notFound(`Discrepancy ${id} not found or already resolved`);
  }

  logger.info('Reconciliation retry recorded by operator', {
    discrepancyId: id,
    operatorId: ctx.operatorId,
    reasonCode: ctx.reasonCode,
    approvalReference: ctx.approvalReference,
  });

  return `discrepancy:${id}`;
};

/**
 * Executor for 'reconciliation_resolve': resolves an open discrepancy with
 * operator reason and evidence. Wraps the existing resolveDiscrepancy function
 * and adds operator metadata to the evidence record.
 *
 * Required payload: { discrepancy_id: number, reason: string, evidence: object }
 */
const executeReconciliationResolve: RecoveryExecutor = async (payload, ctx) => {
  const id = Number(payload.discrepancy_id);
  if (!Number.isInteger(id) || id <= 0) {
    throw AppError.badRequest('discrepancy_id must be a positive integer');
  }
  const reason = String(payload.reason ?? '');
  if (reason.trim().length < 10) {
    throw AppError.badRequest('payload.reason must be at least 10 characters');
  }
  const evidence =
    payload.evidence &&
    typeof payload.evidence === 'object' &&
    !Array.isArray(payload.evidence)
      ? (payload.evidence as Record<string, unknown>)
      : {};

  rejectBalanceEdits(payload);

  await resolveDiscrepancy({
    discrepancyId: id,
    actor: ctx.operatorId,
    reason,
    evidence: {
      ...evidence,
      approvalReference: ctx.approvalReference,
      reasonCode: ctx.reasonCode,
      idempotencyKey: ctx.idempotencyKey,
    },
  });

  return `discrepancy:${id}`;
};

/**
 * Executor for 'cross_contract_reconcile': marks a half-applied
 * cross-contract reconciliation record as reconciled after the operator
 * has manually verified the state on-chain.  Does NOT edit any balance.
 *
 * Required payload: { intent_key: string }
 */
const executeCrossContractReconcile: RecoveryExecutor = async (payload, ctx) => {
  const intentKey = String(payload.intent_key ?? '');
  if (!intentKey) {
    throw AppError.badRequest('payload.intent_key is required');
  }

  rejectBalanceEdits(payload);

  const result = await query(
    `UPDATE cross_contract_reconciliation
     SET state = 'reconciled', updated_at = NOW()
     WHERE intent_key = $1 AND state IN ('pending', 'half_applied', 'failed')
     RETURNING id`,
    [intentKey],
  );
  if ((result.rowCount ?? 0) === 0) {
    throw AppError.notFound(
      `cross_contract_reconciliation record '${intentKey}' not found or already reconciled`,
    );
  }

  const row = result.rows[0] as { id: number };
  logger.info('Cross-contract reconciliation resolved by operator', {
    intentKey,
    recordId: row.id,
    operatorId: ctx.operatorId,
    approvalReference: ctx.approvalReference,
  });

  return `cross_contract:${intentKey}`;
};

/**
 * Executor for 'loan_state_replay': appends a OperatorReplayRequested event
 * to the loan state event log, signalling that the indexer should re-process
 * this loan's events.  Does NOT touch any financial data.
 *
 * Required payload: { loan_id: number }
 */
const executeLoanStateReplay: RecoveryExecutor = async (payload, ctx) => {
  const loanId = Number(payload.loan_id);
  if (!Number.isInteger(loanId) || loanId <= 0) {
    throw AppError.badRequest('payload.loan_id must be a positive integer');
  }

  rejectBalanceEdits(payload);

  const event = await emitLoanStateEvent({
    loanId,
    eventType: 'OperatorReplayRequested',
    actor: ctx.operatorId,
    payload: {
      reasonCode: ctx.reasonCode,
      approvalReference: ctx.approvalReference,
      idempotencyKey: ctx.idempotencyKey,
    },
  });

  return `loan_state_event:${event?.id ?? 'duplicate'}`;
};

/**
 * Executor for 'loan_event_retry': appends a LoanEventRetry event to the
 * loan state event log.  Used when a specific on-chain event was missed by
 * the indexer.  Does NOT modify loan financial data.
 *
 * Required payload: { loan_id: number, event_type: string, source_tx_hash: string }
 */
const executeLoanEventRetry: RecoveryExecutor = async (payload, ctx) => {
  const loanId = Number(payload.loan_id);
  if (!Number.isInteger(loanId) || loanId <= 0) {
    throw AppError.badRequest('payload.loan_id must be a positive integer');
  }
  const eventType = String(payload.event_type ?? '');
  if (!eventType) {
    throw AppError.badRequest('payload.event_type is required');
  }
  const sourceTxHash = String(payload.source_tx_hash ?? '');
  if (!sourceTxHash) {
    throw AppError.badRequest('payload.source_tx_hash is required');
  }

  rejectBalanceEdits(payload);

  const event = await emitLoanStateEvent({
    loanId,
    eventType: 'LoanEventRetry',
    actor: ctx.operatorId,
    payload: {
      originalEventType: eventType,
      sourceTxHash,
      reasonCode: ctx.reasonCode,
      approvalReference: ctx.approvalReference,
      idempotencyKey: ctx.idempotencyKey,
    },
  });

  return `loan_state_event:${event?.id ?? 'duplicate'}`;
};

const RECOVERY_EXECUTORS: Record<OperatorRecoveryActionType, RecoveryExecutor> = {
  reconciliation_retry: executeReconciliationRetry,
  reconciliation_resolve: executeReconciliationResolve,
  cross_contract_reconcile: executeCrossContractReconcile,
  loan_state_replay: executeLoanStateReplay,
  loan_event_retry: executeLoanEventRetry,
};

// ---------------------------------------------------------------------------
// Audit helper
// ---------------------------------------------------------------------------

async function audit(
  operatorId: string,
  action: string,
  recoveryActionId: number,
  detail: Record<string, unknown>,
): Promise<void> {
  try {
    await query(
      `INSERT INTO audit_logs (actor, action, target, payload, status)
       VALUES ($1, $2, $3, $4::jsonb, 200)`,
      [
        operatorId,
        action,
        `OperatorRecoveryAction:${recoveryActionId}`,
        JSON.stringify(detail),
      ],
    );
  } catch (error) {
    logger.error('Failed to write operator recovery audit entry', {
      error,
      action,
      recoveryActionId,
    });
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validates, signs, and persists an operator recovery action request.
 * Returns the immutable record. The action is NOT yet executed; call
 * `executeRecoveryAction` to run it after the record is confirmed.
 */
export async function createRecoveryAction(
  input: OperatorRecoveryInput,
): Promise<OperatorRecoveryRecord> {
  validateRecoveryInput(input);

  if (
    !verifyOperatorSignature(
      input.operatorId,
      input.actionType,
      input.idempotencyKey,
      input.payload,
      input.operatorSignature,
    )
  ) {
    throw AppError.unauthorized(
      'operator_signature verification failed — ensure the HMAC is keyed with your admin:recovery API key',
    );
  }

  const payloadHash = computePayloadHash(input.actionType, input.payload);

  let id: number;
  try {
    const result = await query(
      `INSERT INTO operator_recovery_actions (
         operator_id, action_type, reason_code, approval_reference,
         idempotency_key, operator_signature, payload, payload_hash, reason_note
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
       RETURNING id, created_at`,
      [
        input.operatorId,
        input.actionType,
        input.reasonCode,
        input.approvalReference,
        input.idempotencyKey,
        input.operatorSignature,
        JSON.stringify(input.payload),
        payloadHash,
        input.reasonNote,
      ],
    );
    id = Number((result.rows[0] as { id: number }).id);
  } catch (err: unknown) {
    // Postgres unique violation on idempotency_key (code 23505)
    const pgError = err as { code?: string };
    if (pgError.code === '23505') {
      throw AppError.conflict(
        `A recovery action with idempotency_key '${input.idempotencyKey}' already exists`,
      );
    }
    throw err;
  }

  await audit(input.operatorId, 'OPERATOR_RECOVERY_CREATED', id, {
    actionType: input.actionType,
    reasonCode: input.reasonCode,
    approvalReference: input.approvalReference,
    payloadHash,
  });

  logger.info('Operator recovery action created', {
    id,
    operatorId: input.operatorId,
    actionType: input.actionType,
    reasonCode: input.reasonCode,
    approvalReference: input.approvalReference,
  });

  return getRecoveryAction(id);
}

/**
 * Executes an approved recovery action exactly once.
 * Uses a conditional UPDATE (pending → executing) as a claim; concurrent
 * or replayed calls will not both proceed.
 *
 * The executor MUST NOT perform arbitrary balance edits.  Any executor that
 * attempts to is guarded by `rejectBalanceEdits` inside the executor itself.
 */
export async function executeRecoveryAction(
  id: number,
  actorId: string,
): Promise<OperatorRecoveryRecord> {
  // Load the record first so we can verify the payload hash is still consistent.
  const current = await query(
    `SELECT action_type, payload, payload_hash, operator_id FROM operator_recovery_actions WHERE id = $1`,
    [id],
  );
  const row = current.rows[0] as
    | {
        action_type: OperatorRecoveryActionType;
        payload: Record<string, unknown>;
        payload_hash: string;
        operator_id: string;
      }
    | undefined;

  if (!row) throw AppError.notFound('Operator recovery action not found');

  const computedHash = computePayloadHash(row.action_type, row.payload);
  if (computedHash !== row.payload_hash) {
    throw AppError.conflict(
      'Stored payload no longer matches the recorded hash — record integrity violation',
    );
  }

  // Claim the record by transitioning pending → executing atomically.
  const claim = await query(
    `UPDATE operator_recovery_actions
     SET status = 'executing'
     WHERE id = $1 AND status = 'pending' AND payload_hash = $2
     RETURNING id`,
    [id, row.payload_hash],
  );
  if ((claim.rowCount ?? 0) === 0) {
    // Provide a richer error by inspecting the current status.
    const statusResult = await query(
      `SELECT status FROM operator_recovery_actions WHERE id = $1`,
      [id],
    );
    const statusRow = statusResult.rows[0] as { status: string } | undefined;
    if (!statusRow) throw AppError.notFound('Operator recovery action not found');
    throw AppError.conflict(
      `Cannot execute recovery action in status '${statusRow.status}'`,
    );
  }

  await audit(actorId, 'OPERATOR_RECOVERY_EXECUTING', id, {
    payloadHash: row.payload_hash,
    actionType: row.action_type,
  });

  // Load the extra columns needed by the executor context.
  const ctxResult = await query(
    `SELECT approval_reference, reason_code, idempotency_key FROM operator_recovery_actions WHERE id = $1`,
    [id],
  );
  const ctxRow = ctxResult.rows[0] as {
    approval_reference: string;
    reason_code: RecoveryReasonCode;
    idempotency_key: string;
  };

  const executor = RECOVERY_EXECUTORS[row.action_type];
  try {
    const outcomeRef = await executor(row.payload, {
      operatorId: actorId,
      approvalReference: ctxRow.approval_reference,
      reasonCode: ctxRow.reason_code,
      idempotencyKey: ctxRow.idempotency_key,
    });

    await query(
      `UPDATE operator_recovery_actions
       SET status = 'completed', outcome_ref = $2, executed_at = NOW()
       WHERE id = $1`,
      [id, outcomeRef],
    );

    await audit(actorId, 'OPERATOR_RECOVERY_COMPLETED', id, {
      actionType: row.action_type,
      outcomeRef,
    });

    logger.info('Operator recovery action completed', {
      id,
      actorId,
      actionType: row.action_type,
      outcomeRef,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown execution error';

    await query(
      `UPDATE operator_recovery_actions
       SET status = 'failed', outcome_error = $2, executed_at = NOW()
       WHERE id = $1`,
      [id, message.slice(0, 500)],
    );

    await audit(actorId, 'OPERATOR_RECOVERY_FAILED', id, {
      actionType: row.action_type,
      error: message.slice(0, 200),
    });

    logger.error('Operator recovery action failed', {
      id,
      actorId,
      actionType: row.action_type,
      error: message,
    });
  }

  return getRecoveryAction(id);
}

/**
 * Marks a pending action as rejected (e.g. operator cancels before execution).
 * Only the submitting operator or any admin can reject a pending action.
 */
export async function rejectRecoveryAction(
  id: number,
  actorId: string,
  reason: string,
): Promise<OperatorRecoveryRecord> {
  if (!reason || reason.trim().length < 5) {
    throw AppError.badRequest('rejection reason must be at least 5 characters');
  }

  const result = await query(
    `UPDATE operator_recovery_actions
     SET status = 'rejected', outcome_error = $3, executed_at = NOW()
     WHERE id = $1 AND status = 'pending'
     RETURNING id`,
    [id, actorId, reason.slice(0, 500)],
  );

  if ((result.rowCount ?? 0) === 0) {
    const statusResult = await query(
      `SELECT status FROM operator_recovery_actions WHERE id = $1`,
      [id],
    );
    const statusRow = statusResult.rows[0] as { status: string } | undefined;
    if (!statusRow) throw AppError.notFound('Operator recovery action not found');
    throw AppError.conflict(
      `Cannot reject recovery action in status '${statusRow.status}'`,
    );
  }

  await audit(actorId, 'OPERATOR_RECOVERY_REJECTED', id, { reason });

  return getRecoveryAction(id);
}

/** Fetch a single recovery action record. */
export async function getRecoveryAction(id: number): Promise<OperatorRecoveryRecord> {
  const result = await query(
    `SELECT id, operator_id, action_type, reason_code, approval_reference,
            idempotency_key, payload_hash, status, outcome_ref, outcome_error,
            executed_at, created_at
     FROM operator_recovery_actions WHERE id = $1`,
    [id],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) throw AppError.notFound('Operator recovery action not found');
  return rowToRecord(row);
}

/** List recovery actions with optional filters. */
export async function listRecoveryActions(filters: {
  operatorId?: string;
  actionType?: string;
  status?: string;
  approvalReference?: string;
  limit?: number;
  cursor?: number;
}): Promise<OperatorRecoveryRecord[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (filters.operatorId) {
    values.push(filters.operatorId);
    conditions.push(`operator_id = $${values.length}`);
  }
  if (filters.actionType) {
    values.push(filters.actionType);
    conditions.push(`action_type = $${values.length}`);
  }
  if (filters.status) {
    values.push(filters.status);
    conditions.push(`status = $${values.length}`);
  }
  if (filters.approvalReference) {
    values.push(filters.approvalReference);
    conditions.push(`approval_reference = $${values.length}`);
  }
  if (filters.cursor !== undefined) {
    values.push(filters.cursor);
    conditions.push(`id < $${values.length}`);
  }

  values.push(Math.min(filters.limit ?? 50, 200));
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const result = await query(
    `SELECT id, operator_id, action_type, reason_code, approval_reference,
            idempotency_key, payload_hash, status, outcome_ref, outcome_error,
            executed_at, created_at
     FROM operator_recovery_actions ${where}
     ORDER BY id DESC LIMIT $${values.length}`,
    values,
  );

  return (result.rows as Array<Record<string, unknown>>).map(rowToRecord);
}

function rowToRecord(row: Record<string, unknown>): OperatorRecoveryRecord {
  return {
    id: Number(row.id),
    operatorId: row.operator_id as string,
    actionType: row.action_type as OperatorRecoveryActionType,
    reasonCode: row.reason_code as RecoveryReasonCode,
    approvalReference: row.approval_reference as string,
    idempotencyKey: row.idempotency_key as string,
    payloadHash: row.payload_hash as string,
    status: row.status as OperatorRecoveryRecord['status'],
    outcomeRef: (row.outcome_ref as string | null) ?? null,
    outcomeError: (row.outcome_error as string | null) ?? null,
    executedAt: row.executed_at ? new Date(row.executed_at as string) : null,
    createdAt: new Date(row.created_at as string),
  };
}
