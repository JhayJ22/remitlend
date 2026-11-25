/**
 * Break-glass production access service (issue #849).
 *
 * Implements the full lifecycle of a break-glass emergency access grant:
 *   request → approve/deny → activate → [expiry sweep] → expired
 *                          ↘ revoke (any state before terminal)
 *
 * Safety invariants (enforced at both application and DB layers):
 *   1. Requester cannot approve their own request (DB CHECK + app guard).
 *   2. Granted scopes must be a subset of BREAK_GLASS_ALLOWED_SCOPES.
 *   3. Duration may not exceed BREAK_GLASS_MAX_DURATION_HOURS (default 4 h).
 *   4. The ticket_ref, requester, reason, and requested_scopes are immutable
 *      once written (DB trigger + this service never touches them on update).
 *   5. Every lifecycle event is written to audit_logs and fires an alert.
 *   6. The expiry scheduler revokes active grants automatically; no manual
 *      step is required to end a grant.
 *   7. No financial data is written or mutated by this service.
 */

import crypto from 'node:crypto';
import { query } from '../db/connection.js';
import { AppError } from '../errors/AppError.js';
import { jobMetricsService } from './jobMetricsService.js';
import logger from '../utils/logger.js';

// ── Constants ─────────────────────────────────────────────────────────────

const JOB_NAME = 'breakGlassExpirySweep';

/** Scopes that may be granted via break-glass. Must be explicit least-privilege. */
export const BREAK_GLASS_ALLOWED_SCOPES: readonly string[] = [
  'read:loans',
  'write:loans',
  'read:score',
  'read:remittances',
  'read:webhooks',
  'admin:indexer',
  'admin:reconciliation',
  'admin:loans',
  'admin:disputes',
];

function getMaxDurationSeconds(): number {
  const hours = Number(process.env.BREAK_GLASS_MAX_DURATION_HOURS ?? 4);
  return (Number.isFinite(hours) && hours > 0 ? hours : 4) * 3600;
}

function getDefaultDurationSeconds(): number {
  const hours = Number(process.env.BREAK_GLASS_DEFAULT_DURATION_HOURS ?? 1);
  return (Number.isFinite(hours) && hours > 0 ? hours : 1) * 3600;
}

// ── Types ─────────────────────────────────────────────────────────────────

export type BreakGlassState =
  | 'pending'
  | 'approved'
  | 'active'
  | 'denied'
  | 'expired'
  | 'revoked';

export interface BreakGlassGrant {
  id: number;
  ticketRef: string;
  reason: string;
  requester: string;
  approver: string | null;
  requestedScopes: string[];
  grantedScopes: string[] | null;
  state: BreakGlassState;
  durationSeconds: number;
  expiresAt: Date | null;
  approvedAt: Date | null;
  activatedAt: Date | null;
  revokedAt: Date | null;
  revokedBy: string | null;
  revocationReason: string | null;
  deniedAt: Date | null;
  denialReason: string | null;
  expiredAt: Date | null;
  alertSentAt: Date | null;
  alertChannels: string[] | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RequestBreakGlassInput {
  ticketRef: string;
  reason: string;
  requester: string;
  requestedScopes: string[];
  durationSeconds?: number;
}

export interface ApproveBreakGlassInput {
  id: number;
  approver: string;
  /** Approver may grant a strict subset of requested scopes. */
  grantedScopes: string[];
}

export interface DenyBreakGlassInput {
  id: number;
  approver: string;
  denialReason: string;
}

export interface RevokeBreakGlassInput {
  id: number;
  revokedBy: string;
  revocationReason: string;
}

export interface ExpirySweepResult {
  expired: number;
  errors: number;
}

// ── DB row mapper ─────────────────────────────────────────────────────────

function mapRow(row: Record<string, unknown>): BreakGlassGrant {
  return {
    id: Number(row.id),
    ticketRef: String(row.ticket_ref ?? ''),
    reason: String(row.reason ?? ''),
    requester: String(row.requester ?? ''),
    approver: row.approver != null ? String(row.approver) : null,
    requestedScopes: Array.isArray(row.requested_scopes) ? (row.requested_scopes as string[]) : [],
    grantedScopes: Array.isArray(row.granted_scopes) ? (row.granted_scopes as string[]) : null,
    state: String(row.state ?? 'pending') as BreakGlassState,
    durationSeconds: Number(row.duration_seconds ?? 0),
    expiresAt: row.expires_at ? new Date(String(row.expires_at)) : null,
    approvedAt: row.approved_at ? new Date(String(row.approved_at)) : null,
    activatedAt: row.activated_at ? new Date(String(row.activated_at)) : null,
    revokedAt: row.revoked_at ? new Date(String(row.revoked_at)) : null,
    revokedBy: row.revoked_by != null ? String(row.revoked_by) : null,
    revocationReason: row.revocation_reason != null ? String(row.revocation_reason) : null,
    deniedAt: row.denied_at ? new Date(String(row.denied_at)) : null,
    denialReason: row.denial_reason != null ? String(row.denial_reason) : null,
    expiredAt: row.expired_at ? new Date(String(row.expired_at)) : null,
    alertSentAt: row.alert_sent_at ? new Date(String(row.alert_sent_at)) : null,
    alertChannels: Array.isArray(row.alert_channels) ? (row.alert_channels as string[]) : null,
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
  };
}

// ── Audit helper ──────────────────────────────────────────────────────────

async function audit(
  actor: string,
  action: string,
  grantId: number,
  detail: Record<string, unknown>,
): Promise<void> {
  try {
    await query(
      `INSERT INTO audit_logs (actor, action, target, payload, status)
       VALUES ($1, $2, $3, $4::jsonb, 200)`,
      [
        actor,
        action,
        `BreakGlass:${grantId}`,
        JSON.stringify({ grantId, ...detail }),
      ],
    );
  } catch (err) {
    logger.error('Failed to write break-glass audit entry', { err, action, grantId });
  }
}

// ── Alert helper ──────────────────────────────────────────────────────────

/**
 * Sends an alert notification for a break-glass lifecycle event.
 * Uses the same three-channel pattern as notificationService.notifyAdmins():
 *   1. ADMIN_EMAIL via logger (email infrastructure is optional)
 *   2. ADMIN_WEBHOOK_URL (Slack/Discord/PagerDuty)
 *   3. Structured log at WARN level (always present for log-based alerting)
 *
 * Alert failures are non-fatal but are logged at ERROR level so alerting
 * gaps appear in monitoring.
 *
 * Returns the channels that were successfully used.
 */
async function sendAlert(params: {
  grantId: number;
  event: string;
  requester: string;
  ticketRef: string;
  detail: string;
}): Promise<string[]> {
  const { grantId, event, requester, ticketRef, detail } = params;
  const channels: string[] = [];

  const title = `[BREAK-GLASS] ${event}`;
  const body = `Grant #${grantId} | Requester: ${requester} | Ticket: ${ticketRef} | ${detail}`;

  // 1. Structured log (always fires — picked up by any log-based alerter)
  logger.withContext().warn('BREAK_GLASS_ALERT', {
    alert: 'break_glass',
    event,
    grantId,
    requester,
    ticketRef,
    detail,
  });
  channels.push('log');

  // 2. Webhook (Slack/Discord/PagerDuty compatible)
  const webhookUrl = process.env.ADMIN_WEBHOOK_URL ?? process.env.BREAK_GLASS_ALERT_WEBHOOK;
  if (webhookUrl) {
    try {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `${title}: ${body}`,
          attachments: [
            {
              color: event.includes('REVOKE') || event.includes('DENY')
                ? '#36a64f'
                : '#d00000',
              fields: [
                { title: 'Grant ID', value: String(grantId), short: true },
                { title: 'Requester', value: requester, short: true },
                { title: 'Ticket', value: ticketRef, short: true },
                { title: 'Event', value: event, short: true },
              ],
            },
          ],
        }),
      });
      channels.push('webhook');
    } catch (err) {
      logger.error('Break-glass webhook alert failed', { webhookUrl, err });
    }
  }

  // 3. Record alert_sent_at and channels on the grant row.
  try {
    await query(
      `UPDATE break_glass_grants
       SET alert_sent_at = NOW(), alert_channels = $2
       WHERE id = $1`,
      [grantId, channels],
    );
  } catch (err) {
    logger.error('Failed to record break-glass alert timestamp', { err, grantId });
  }

  return channels;
}

// ── Validation helpers ────────────────────────────────────────────────────

function validateScopes(scopes: string[], context: string): void {
  const invalid = scopes.filter((s) => !BREAK_GLASS_ALLOWED_SCOPES.includes(s));
  if (invalid.length > 0) {
    throw AppError.badRequest(
      `${context}: scopes [${invalid.join(', ')}] are not permitted for break-glass access. ` +
        `Allowed scopes: ${BREAK_GLASS_ALLOWED_SCOPES.join(', ')}`,
    );
  }
  if (scopes.length === 0) {
    throw AppError.badRequest(`${context}: at least one scope must be requested`);
  }
}

function validateGrantedSubset(requested: string[], granted: string[]): void {
  const notRequested = granted.filter((s) => !requested.includes(s));
  if (notRequested.length > 0) {
    throw AppError.badRequest(
      `Granted scopes [${notRequested.join(', ')}] were not in the requested scopes. ` +
        'Approvers may only grant a subset of what was requested.',
    );
  }
}

// ── Core service functions ────────────────────────────────────────────────

/**
 * Request a break-glass access grant.
 *
 * Rules:
 *   - ticketRef must be non-empty (external audit anchor)
 *   - reason must be ≥ 20 characters
 *   - requestedScopes must be non-empty and all within BREAK_GLASS_ALLOWED_SCOPES
 *   - durationSeconds must not exceed BREAK_GLASS_MAX_DURATION_HOURS
 *   - No financial side effects
 */
export async function requestBreakGlass(
  input: RequestBreakGlassInput,
): Promise<BreakGlassGrant> {
  const { ticketRef, reason, requester, requestedScopes } = input;

  if (!ticketRef || ticketRef.trim().length === 0) {
    throw AppError.badRequest('ticketRef is required — provide an incident or change ticket ID');
  }
  if (!reason || reason.trim().length < 20) {
    throw AppError.badRequest(
      'reason must be at least 20 characters describing the emergency',
    );
  }
  if (!requester || requester.trim().length === 0) {
    throw AppError.badRequest('requester is required');
  }

  validateScopes(requestedScopes, 'requestedScopes');

  const maxDuration = getMaxDurationSeconds();
  const durationSeconds = input.durationSeconds ?? getDefaultDurationSeconds();
  if (durationSeconds <= 0 || durationSeconds > maxDuration) {
    throw AppError.badRequest(
      `durationSeconds must be between 1 and ${maxDuration} ` +
        `(${maxDuration / 3600}h maximum)`,
    );
  }

  const result = await query(
    `INSERT INTO break_glass_grants
       (ticket_ref, reason, requester, requested_scopes, duration_seconds, state)
     VALUES ($1, $2, $3, $4, $5, 'pending')
     RETURNING *`,
    [ticketRef.trim(), reason.trim(), requester, requestedScopes, durationSeconds],
  );

  const grant = mapRow(result.rows[0] as Record<string, unknown>);

  await audit(requester, 'BREAK_GLASS_REQUESTED', grant.id, {
    ticketRef,
    requestedScopes,
    durationSeconds,
  });

  await sendAlert({
    grantId: grant.id,
    event: 'BREAK_GLASS_REQUESTED',
    requester,
    ticketRef: ticketRef.trim(),
    detail: `Requested scopes: ${requestedScopes.join(', ')} for ${durationSeconds}s`,
  });

  return grant;
}

/**
 * Approve a pending break-glass grant.
 *
 * Rules:
 *   - Grant must be in `pending` state
 *   - Approver must differ from requester (DB CHECK + app guard)
 *   - grantedScopes must be a non-empty subset of requestedScopes
 *   - Grants may only be approved by admin-role wallets (enforced at the
 *     HTTP layer via requireRoles('admin'))
 */
export async function approveBreakGlass(
  input: ApproveBreakGlassInput,
): Promise<BreakGlassGrant> {
  const { id, approver, grantedScopes } = input;

  if (!approver || approver.trim().length === 0) {
    throw AppError.badRequest('approver is required');
  }
  validateScopes(grantedScopes, 'grantedScopes');

  // Fetch to validate state and get requester for self-approval check.
  const existing = await getGrantById(id);

  if (existing.requester === approver) {
    throw AppError.forbidden('Requester cannot approve their own break-glass request');
  }

  validateGrantedSubset(existing.requestedScopes, grantedScopes);

  if (existing.state !== 'pending') {
    throw AppError.conflict(
      `Break-glass grant #${id} cannot be approved in state '${existing.state}'`,
    );
  }

  const result = await query(
    `UPDATE break_glass_grants
     SET state = 'approved',
         approver = $2,
         granted_scopes = $3,
         approved_at = NOW()
     WHERE id = $1 AND state = 'pending' AND requester <> $2
     RETURNING *`,
    [id, approver, grantedScopes],
  );

  if (result.rows.length === 0) {
    throw AppError.conflict(
      'Approval failed — grant may have been modified concurrently or self-approval attempted',
    );
  }

  const grant = mapRow(result.rows[0] as Record<string, unknown>);

  await audit(approver, 'BREAK_GLASS_APPROVED', id, {
    grantedScopes,
    requester: existing.requester,
    ticketRef: existing.ticketRef,
  });

  await sendAlert({
    grantId: id,
    event: 'BREAK_GLASS_APPROVED',
    requester: existing.requester,
    ticketRef: existing.ticketRef,
    detail: `Approved by ${approver} with scopes: ${grantedScopes.join(', ')}`,
  });

  return grant;
}

/**
 * Deny a pending break-glass grant.
 *
 * Rules:
 *   - Grant must be in `pending` state
 *   - Approver must differ from requester
 *   - Denial reason is required
 */
export async function denyBreakGlass(input: DenyBreakGlassInput): Promise<BreakGlassGrant> {
  const { id, approver, denialReason } = input;

  if (!denialReason || denialReason.trim().length < 10) {
    throw AppError.badRequest('denialReason must be at least 10 characters');
  }

  const existing = await getGrantById(id);

  if (existing.requester === approver) {
    throw AppError.forbidden('Requester cannot deny their own break-glass request');
  }
  if (existing.state !== 'pending') {
    throw AppError.conflict(
      `Break-glass grant #${id} cannot be denied in state '${existing.state}'`,
    );
  }

  const result = await query(
    `UPDATE break_glass_grants
     SET state = 'denied',
         approver = $2,
         denial_reason = $3,
         denied_at = NOW()
     WHERE id = $1 AND state = 'pending' AND requester <> $2
     RETURNING *`,
    [id, approver, denialReason.trim()],
  );

  if (result.rows.length === 0) {
    throw AppError.conflict('Denial failed — grant may have been modified concurrently');
  }

  const grant = mapRow(result.rows[0] as Record<string, unknown>);

  await audit(approver, 'BREAK_GLASS_DENIED', id, {
    denialReason: denialReason.trim(),
    requester: existing.requester,
    ticketRef: existing.ticketRef,
  });

  await sendAlert({
    grantId: id,
    event: 'BREAK_GLASS_DENIED',
    requester: existing.requester,
    ticketRef: existing.ticketRef,
    detail: `Denied by ${approver}: ${denialReason.trim()}`,
  });

  return grant;
}

/**
 * Activate an approved break-glass grant.
 *
 * The requester must call this endpoint to start the access window. The
 * expiry clock starts at activation, not at approval. Only the requester
 * may activate (they must be present to use the access).
 */
export async function activateBreakGlass(
  id: number,
  requester: string,
): Promise<BreakGlassGrant> {
  const existing = await getGrantById(id);

  if (existing.requester !== requester) {
    throw AppError.forbidden('Only the requester may activate a break-glass grant');
  }
  if (existing.state !== 'approved') {
    throw AppError.conflict(
      `Break-glass grant #${id} cannot be activated in state '${existing.state}'`,
    );
  }

  const result = await query(
    `UPDATE break_glass_grants
     SET state = 'active',
         activated_at = NOW(),
         expires_at = NOW() + (duration_seconds * INTERVAL '1 second')
     WHERE id = $1 AND state = 'approved' AND requester = $2
     RETURNING *`,
    [id, requester],
  );

  if (result.rows.length === 0) {
    throw AppError.conflict('Activation failed — grant may have been modified concurrently');
  }

  const grant = mapRow(result.rows[0] as Record<string, unknown>);

  await audit(requester, 'BREAK_GLASS_ACTIVATED', id, {
    expiresAt: grant.expiresAt?.toISOString(),
    grantedScopes: grant.grantedScopes,
    ticketRef: existing.ticketRef,
  });

  await sendAlert({
    grantId: id,
    event: 'BREAK_GLASS_ACTIVATED',
    requester,
    ticketRef: existing.ticketRef,
    detail: `Access active until ${grant.expiresAt?.toISOString() ?? 'unknown'} with scopes: ${grant.grantedScopes?.join(', ') ?? 'none'}`,
  });

  return grant;
}

/**
 * Revoke a break-glass grant.
 *
 * Any admin may revoke from any non-terminal state. The requester may
 * also revoke their own grant. Terminal states (expired, revoked, denied)
 * cannot be revoked again.
 */
export async function revokeBreakGlass(input: RevokeBreakGlassInput): Promise<BreakGlassGrant> {
  const { id, revokedBy, revocationReason } = input;

  if (!revocationReason || revocationReason.trim().length < 10) {
    throw AppError.badRequest('revocationReason must be at least 10 characters');
  }

  const result = await query(
    `UPDATE break_glass_grants
     SET state = 'revoked',
         revoked_at = NOW(),
         revoked_by = $2,
         revocation_reason = $3
     WHERE id = $1
       AND state NOT IN ('expired', 'revoked', 'denied')
     RETURNING *`,
    [id, revokedBy, revocationReason.trim()],
  );

  if (result.rows.length === 0) {
    // Provide a clear explanation.
    const existing = await getGrantById(id);
    throw AppError.conflict(
      `Break-glass grant #${id} cannot be revoked in terminal state '${existing.state}'`,
    );
  }

  const grant = mapRow(result.rows[0] as Record<string, unknown>);

  await audit(revokedBy, 'BREAK_GLASS_REVOKED', id, {
    revocationReason: revocationReason.trim(),
    requester: grant.requester,
    ticketRef: grant.ticketRef,
    previousState: 'active/approved/pending',
  });

  await sendAlert({
    grantId: id,
    event: 'BREAK_GLASS_REVOKED',
    requester: grant.requester,
    ticketRef: grant.ticketRef,
    detail: `Revoked by ${revokedBy}: ${revocationReason.trim()}`,
  });

  return grant;
}

/**
 * Fetch a single grant by ID. Throws 404 if not found.
 */
export async function getGrantById(id: number): Promise<BreakGlassGrant> {
  const result = await query(
    `SELECT * FROM break_glass_grants WHERE id = $1`,
    [id],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    throw AppError.notFound(`Break-glass grant #${id} not found`);
  }
  return mapRow(row);
}

/**
 * List grants with optional filters and cursor pagination.
 */
export async function listGrants(opts: {
  state?: BreakGlassState;
  requester?: string;
  limit?: number;
  cursor?: number;
}): Promise<BreakGlassGrant[]> {
  const limit = Math.min(opts.limit ?? 50, 200);
  const params: unknown[] = [limit + 1];
  const conditions: string[] = [];

  if (opts.state) {
    params.push(opts.state);
    conditions.push(`state = $${params.length}`);
  }
  if (opts.requester) {
    params.push(opts.requester);
    conditions.push(`requester = $${params.length}`);
  }
  if (opts.cursor) {
    params.push(opts.cursor);
    conditions.push(`id < $${params.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await query(
    `SELECT * FROM break_glass_grants ${where} ORDER BY id DESC LIMIT $1`,
    params,
  );
  return (result.rows as Record<string, unknown>[]).map(mapRow).slice(0, limit);
}

/**
 * Verify that a requester currently has an active grant covering the
 * given scope. Used by middleware or other services to check whether a
 * break-glass scope elevation is in effect.
 *
 * Returns the matching grant if active, null otherwise.
 */
export async function getActiveGrant(
  requester: string,
  scope: string,
): Promise<BreakGlassGrant | null> {
  const result = await query(
    `SELECT * FROM break_glass_grants
     WHERE requester = $1
       AND state = 'active'
       AND expires_at > NOW()
       AND $2 = ANY(granted_scopes)
     ORDER BY expires_at DESC
     LIMIT 1`,
    [requester, scope],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  return row ? mapRow(row) : null;
}

// ── Expiry sweep (called by scheduler) ───────────────────────────────────

/**
 * Marks all active grants whose expires_at has passed as 'expired'.
 * Called by the break-glass expiry sweep scheduler.
 * Returns the number of grants expired and any errors encountered.
 */
export async function runExpirySweep(): Promise<ExpirySweepResult> {
  const startTime = Date.now();
  const result: ExpirySweepResult = { expired: 0, errors: 0 };

  try {
    // Fetch grants to expire so we can alert on each one individually.
    const toExpire = await query(
      `UPDATE break_glass_grants
       SET state = 'expired', expired_at = NOW()
       WHERE state = 'active' AND expires_at <= NOW()
       RETURNING id, requester, ticket_ref, granted_scopes`,
    );

    result.expired = toExpire.rowCount ?? 0;

    for (const row of toExpire.rows as Array<{
      id: number;
      requester: string;
      ticket_ref: string;
      granted_scopes: string[];
    }>) {
      try {
        await audit(row.requester, 'BREAK_GLASS_EXPIRED', row.id, {
          ticketRef: row.ticket_ref,
          grantedScopes: row.granted_scopes,
          expiredBy: 'scheduler',
        });
        await sendAlert({
          grantId: row.id,
          event: 'BREAK_GLASS_EXPIRED',
          requester: row.requester,
          ticketRef: row.ticket_ref,
          detail: `Grant automatically expired; scopes revoked: ${row.granted_scopes?.join(', ') ?? 'none'}`,
        });
      } catch (err) {
        result.errors += 1;
        logger.error('break_glass_expiry_sweep: per-grant alert/audit failed', {
          grantId: row.id,
          err,
        });
      }
    }

    if (result.expired > 0) {
      logger.withContext().info('break_glass_expiry_sweep.complete', result);
    }
    jobMetricsService.recordSuccess(JOB_NAME, Date.now() - startTime);
  } catch (err) {
    result.errors += 1;
    jobMetricsService.recordFailure(JOB_NAME, err as Error, Date.now() - startTime);
    logger.error('break_glass_expiry_sweep.failed', { err });
    throw err;
  }

  return result;
}

// ── Scheduler ─────────────────────────────────────────────────────────────

let sweepInterval: NodeJS.Timeout | null = null;
let sweepInFlight = false;

export function startBreakGlassExpirySweep(): void {
  if (sweepInterval) {
    logger.withContext().warn('break_glass_expiry_sweep: already running');
    return;
  }

  const intervalMs = Number(process.env.BREAK_GLASS_SWEEP_INTERVAL_MS ?? 60_000);
  logger.withContext().info('break_glass_expiry_sweep: starting', { intervalMs });

  sweepInterval = setInterval(() => {
    if (sweepInFlight) return;
    sweepInFlight = true;

    void runExpirySweep()
      .catch((err) => {
        logger.error('break_glass_expiry_sweep: interval error', { err });
      })
      .finally(() => {
        sweepInFlight = false;
      });
  }, intervalMs);

  sweepInterval.unref();
}

export function stopBreakGlassExpirySweep(): void {
  if (sweepInterval) {
    clearInterval(sweepInterval);
    sweepInterval = null;
    logger.withContext().info('break_glass_expiry_sweep: stopped');
  }
}

export function isBreakGlassSweepRunning(): boolean {
  return sweepInterval !== null;
}
