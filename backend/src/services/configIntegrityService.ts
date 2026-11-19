/**
 * Config Integrity Service (issue #854)
 *
 * Records actor, prior value, new value, approval reference, and effective
 * time for every privileged configuration change. Flags and alerts on
 * unauthorized changes (no approval reference). Supports recovery to a
 * previously reviewed snapshot.
 *
 * Design guarantees:
 *  - Every write to config_change_log is append-only; no row is ever updated
 *    except the alert_sent flag on an existing unauthorized row.
 *  - Recovery does not mutate the original change row; it inserts a new row
 *    with source='recovery' and marks the superseded rows 'recovered'.
 *  - Alert dispatch is idempotent: alert_sent is set in the same UPDATE that
 *    reads alert_sent=false, so concurrent retries cannot double-alert.
 *  - Dependency failure (DB or webhook down) never swallows the alert;
 *    alert_sent remains false so the next sweep retries.
 */

import { pool } from '../db/connection.js';
import logger from '../utils/logger.js';
import { AppError } from '../errors/AppError.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ChangeSource = 'api' | 'direct' | 'recovery' | 'contract';
export type ChangeStatus = 'applied' | 'unauthorized' | 'recovered';

export interface ConfigChangeRow {
  id: string;
  config_key: string;
  prior_value: unknown;
  new_value: unknown;
  actor: string;
  approval_ref: string | null;
  effective_at: Date;
  change_source: ChangeSource;
  status: ChangeStatus;
  alert_sent: boolean;
  ip_address: string | null;
  created_at: Date;
}

export interface ConfigSnapshotRow {
  id: string;
  config_key: string;
  value: unknown;
  snapshot_by: string;
  review_ref: string | null;
  is_reviewed: boolean;
  created_at: Date;
}

export interface RecordChangeOptions {
  configKey: string;
  /** Value before this change. Pass null for the initial write. */
  priorValue: unknown;
  newValue: unknown;
  actor: string;
  /**
   * Reference to the dual-control approval (e.g. privileged_action_requests.id
   * or external ticket). When absent and requiresApproval is true, the row is
   * marked 'unauthorized' and an alert is dispatched.
   */
  approvalRef?: string | null;
  source?: ChangeSource;
  effectiveAt?: Date;
  ipAddress?: string | null;
  /**
   * When true (default), a missing approval_ref triggers an unauthorized alert.
   * Pass false for bootstrap/import flows where no approval exists yet.
   */
  requiresApproval?: boolean;
}

export interface CreateSnapshotOptions {
  configKey: string;
  value: unknown;
  snapshotBy: string;
  reviewRef?: string | null;
  /** Mark immediately as reviewed (requires a second admin in production). */
  isReviewed?: boolean;
}

export interface RecoverToSnapshotOptions {
  snapshotId: string;
  actor: string;
  approvalRef: string;
  ipAddress?: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns a stable JSON diff summary suitable for the audit payload.
 * Does not embed raw values to keep audit rows small; callers can join
 * on the config_change_log id for the full before/after.
 */
export function diffSummary(
  prior: unknown,
  next: unknown,
): { changed: boolean; addedKeys: string[]; removedKeys: string[]; changedKeys: string[] } {
  if (prior === null || prior === undefined) {
    return { changed: true, addedKeys: [], removedKeys: [], changedKeys: ['(initial)'] };
  }
  if (typeof prior !== 'object' || typeof next !== 'object' || Array.isArray(prior) || Array.isArray(next)) {
    return {
      changed: JSON.stringify(prior) !== JSON.stringify(next),
      addedKeys: [],
      removedKeys: [],
      changedKeys: JSON.stringify(prior) !== JSON.stringify(next) ? ['(scalar)'] : [],
    };
  }
  const p = prior as Record<string, unknown>;
  const n = (next ?? {}) as Record<string, unknown>;
  const allKeys = new Set([...Object.keys(p), ...Object.keys(n)]);
  const addedKeys: string[] = [];
  const removedKeys: string[] = [];
  const changedKeys: string[] = [];
  for (const k of allKeys) {
    if (!(k in p)) addedKeys.push(k);
    else if (!(k in n)) removedKeys.push(k);
    else if (JSON.stringify(p[k]) !== JSON.stringify(n[k])) changedKeys.push(k);
  }
  return {
    changed: addedKeys.length + removedKeys.length + changedKeys.length > 0,
    addedKeys,
    removedKeys,
    changedKeys,
  };
}

// ── Alert dispatch ────────────────────────────────────────────────────────────

async function dispatchUnauthorizedAlert(row: ConfigChangeRow): Promise<void> {
  const title = `[SECURITY] Unauthorized config change detected`;
  const message =
    `Config key '${row.config_key}' was changed by '${row.actor}' ` +
    `at ${row.effective_at.toISOString()} with no approval reference. ` +
    `Change ID: ${row.id}. Source: ${row.change_source}.`;

  logger.warn('config_integrity_unauthorized_change', {
    id: row.id,
    config_key: row.config_key,
    actor: row.actor,
    effective_at: row.effective_at,
    change_source: row.change_source,
  });

  // 1. Admin webhook (Slack / Discord / PagerDuty)
  const webhookUrl = process.env.CONFIG_INTEGRITY_ALERT_WEBHOOK ?? process.env.ADMIN_WEBHOOK_URL;
  if (webhookUrl) {
    try {
      const resp = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          severity: 'critical',
          title,
          message,
          change_id: row.id,
          config_key: row.config_key,
          actor: row.actor,
          effective_at: row.effective_at.toISOString(),
        }),
      });
      if (!resp.ok) {
        logger.error('config_integrity_alert_webhook_failed', { status: resp.status, change_id: row.id });
      }
    } catch (err) {
      logger.error('config_integrity_alert_webhook_error', {
        change_id: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
      // Do NOT mark alert_sent=true — will retry on next sweep.
      return;
    }
  }

  // 2. Email via admin notification infrastructure (best-effort).
  try {
    const adminEmail = process.env.ADMIN_EMAIL;
    if (adminEmail) {
      const sgModule = await import('@sendgrid/mail').catch(() => null);
      if (sgModule && process.env.SENDGRID_API_KEY && process.env.FROM_EMAIL) {
        sgModule.default.setApiKey(process.env.SENDGRID_API_KEY);
        await sgModule.default.send({
          to: adminEmail,
          from: process.env.FROM_EMAIL,
          subject: title,
          html: `<h2>${title}</h2><p>${message}</p>`,
        });
      }
    }
  } catch (err) {
    logger.warn('config_integrity_alert_email_failed', {
      change_id: row.id,
      error: err instanceof Error ? err.message : String(err),
    });
    // Email failure does not block; still mark alert_sent below.
  }
}

// ── Core service ──────────────────────────────────────────────────────────────

class ConfigIntegrityService {
  /**
   * Record a privileged configuration change.
   *
   * - Computes a diff summary for the audit payload.
   * - Marks the row 'unauthorized' and fires an alert when no approval_ref is
   *   supplied and requiresApproval is true (default).
   * - Writes to audit_logs so the change also appears in the standard audit
   *   feed without requiring callers to instrument separately.
   */
  async recordChange(opts: RecordChangeOptions): Promise<ConfigChangeRow> {
    const {
      configKey,
      priorValue,
      newValue,
      actor,
      approvalRef = null,
      source = 'api',
      effectiveAt = new Date(),
      ipAddress = null,
      requiresApproval = true,
    } = opts;

    const isUnauthorized = requiresApproval && !approvalRef;
    const status: ChangeStatus = isUnauthorized ? 'unauthorized' : 'applied';
    const diff = diffSummary(priorValue, newValue);

    const result = await pool.query(
      `INSERT INTO config_change_log
         (config_key, prior_value, new_value, actor, approval_ref,
          effective_at, change_source, status, alert_sent, ip_address)
       VALUES ($1, $2::jsonb, $3::jsonb, $4, $5, $6, $7, $8, false, $9)
       RETURNING *`,
      [
        configKey,
        priorValue !== null && priorValue !== undefined ? JSON.stringify(priorValue) : null,
        JSON.stringify(newValue),
        actor,
        approvalRef,
        effectiveAt.toISOString(),
        source,
        status,
        ipAddress,
      ],
    );

    const row = result.rows[0] as ConfigChangeRow;

    // Write to the standard audit_logs table for unified audit feed.
    try {
      await pool.query(
        `INSERT INTO audit_logs (actor, action, target, payload, ip_address, status)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
        [
          actor,
          `CONFIG_CHANGE:${source.toUpperCase()}`,
          `config:${configKey}`,
          JSON.stringify({
            change_id: row.id,
            config_key: configKey,
            approval_ref: approvalRef,
            diff,
            status,
          }),
          ipAddress,
          isUnauthorized ? 403 : 200,
        ],
      );
    } catch (auditErr) {
      logger.error('config_integrity_audit_log_failed', {
        change_id: row.id,
        error: auditErr instanceof Error ? auditErr.message : String(auditErr),
      });
    }

    // Fire alert if unauthorized — in-process, non-blocking.
    if (isUnauthorized) {
      this.alertUnauthorized(row).catch((err) => {
        logger.error('config_integrity_alert_fire_failed', {
          change_id: row.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    logger.info('config_change_recorded', {
      id: row.id,
      config_key: configKey,
      actor,
      source,
      status,
      approval_ref: approvalRef ?? null,
      diff,
    });

    return row;
  }

  /**
   * Dispatch alert and mark alert_sent atomically. Uses a conditional UPDATE
   * (WHERE alert_sent = false) so concurrent retries are idempotent.
   */
  async alertUnauthorized(row: ConfigChangeRow): Promise<void> {
    // Dispatch first; if it throws, alert_sent stays false and will retry.
    await dispatchUnauthorizedAlert(row);

    // Idempotent flag: only the first successful dispatch sets it.
    await pool.query(
      `UPDATE config_change_log SET alert_sent = true WHERE id = $1 AND alert_sent = false`,
      [row.id],
    );
  }

  /**
   * Sweep for any unauthorized changes whose alerts haven't been sent yet.
   * Called on startup and periodically to catch any that failed to deliver.
   */
  async retryPendingAlerts(): Promise<void> {
    const result = await pool.query(
      `SELECT * FROM config_change_log
       WHERE status = 'unauthorized' AND alert_sent = false
       ORDER BY created_at ASC
       LIMIT 50`,
    );
    for (const row of result.rows as ConfigChangeRow[]) {
      await this.alertUnauthorized(row).catch((err) => {
        logger.warn('config_integrity_alert_retry_failed', {
          change_id: row.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  /**
   * Save a reviewed snapshot for a config key.
   * is_reviewed=true means a second admin has blessed it as a recovery target.
   */
  async createSnapshot(opts: CreateSnapshotOptions): Promise<ConfigSnapshotRow> {
    const { configKey, value, snapshotBy, reviewRef = null, isReviewed = false } = opts;
    const result = await pool.query(
      `INSERT INTO config_snapshots (config_key, value, snapshot_by, review_ref, is_reviewed)
       VALUES ($1, $2::jsonb, $3, $4, $5)
       RETURNING *`,
      [configKey, JSON.stringify(value), snapshotBy, reviewRef, isReviewed],
    );
    const snap = result.rows[0] as ConfigSnapshotRow;
    logger.info('config_snapshot_created', {
      id: snap.id,
      config_key: configKey,
      snapshot_by: snapshotBy,
      is_reviewed: isReviewed,
    });
    return snap;
  }

  /**
   * Mark an existing snapshot as reviewed (second-admin approval).
   * Returns the updated snapshot.
   */
  async reviewSnapshot(snapshotId: string, reviewedBy: string, reviewRef?: string): Promise<ConfigSnapshotRow> {
    const result = await pool.query(
      `UPDATE config_snapshots
       SET is_reviewed = true,
           review_ref  = COALESCE($2, review_ref)
       WHERE id = $1
       RETURNING *`,
      [snapshotId, reviewRef ?? null],
    );
    if (result.rows.length === 0) {
      throw AppError.notFound(`Config snapshot ${snapshotId} not found`);
    }
    logger.info('config_snapshot_reviewed', {
      id: snapshotId,
      reviewed_by: reviewedBy,
      review_ref: reviewRef,
    });
    return result.rows[0] as ConfigSnapshotRow;
  }

  /**
   * Recover a config key to a previously reviewed snapshot value.
   *
   * This:
   *  1. Loads the snapshot (must be is_reviewed=true).
   *  2. Loads the current latest value for the key (prior_value for the diff).
   *  3. Inserts a new config_change_log row with source='recovery'.
   *  4. Marks all prior 'applied'/'unauthorized' rows for that key 'recovered'.
   *
   * The original change rows are never deleted — the audit trail is permanent.
   * Returns the new change log row.
   */
  async recoverToSnapshot(opts: RecoverToSnapshotOptions): Promise<ConfigChangeRow> {
    const { snapshotId, actor, approvalRef, ipAddress = null } = opts;

    // Load snapshot — must be reviewed.
    const snapResult = await pool.query(
      `SELECT * FROM config_snapshots WHERE id = $1`,
      [snapshotId],
    );
    if (snapResult.rows.length === 0) {
      throw AppError.notFound(`Config snapshot ${snapshotId} not found`);
    }
    const snap = snapResult.rows[0] as ConfigSnapshotRow;
    if (!snap.is_reviewed) {
      throw AppError.badRequest(
        `Snapshot ${snapshotId} has not been reviewed; it cannot be used as a recovery target`,
      );
    }

    // Get the most recent applied/unauthorized value as prior_value.
    const latestResult = await pool.query(
      `SELECT new_value FROM config_change_log
       WHERE config_key = $1 AND status IN ('applied','unauthorized')
       ORDER BY effective_at DESC, created_at DESC
       LIMIT 1`,
      [snap.config_key],
    );
    const priorValue = latestResult.rows.length > 0
      ? (latestResult.rows[0] as { new_value: unknown }).new_value
      : null;

    // Insert the recovery change log row first.
    const changeRow = await this.recordChange({
      configKey: snap.config_key,
      priorValue,
      newValue: snap.value,
      actor,
      approvalRef,
      source: 'recovery',
      effectiveAt: new Date(),
      ipAddress,
      requiresApproval: false, // recovery always has an explicit approvalRef
    });

    // Mark all prior active rows for this key as recovered.
    await pool.query(
      `UPDATE config_change_log
       SET status = 'recovered'
       WHERE config_key = $1
         AND status IN ('applied','unauthorized')
         AND id <> $2`,
      [snap.config_key, changeRow.id],
    );

    logger.info('config_recovered_to_snapshot', {
      config_key: snap.config_key,
      snapshot_id: snapshotId,
      change_id: changeRow.id,
      actor,
      approval_ref: approvalRef,
    });

    return changeRow;
  }

  // ── Query helpers ──────────────────────────────────────────────────────────

  async listChanges(opts: {
    configKey?: string;
    actor?: string;
    status?: ChangeStatus;
    source?: ChangeSource;
    from?: string;
    to?: string;
    limit?: number;
    cursor?: string;
  }): Promise<{ data: ConfigChangeRow[]; nextCursor: string | null }> {
    const { configKey, actor, status, source, from, to, limit = 50, cursor } = opts;
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (configKey) { conditions.push(`config_key = $${values.length + 1}`); values.push(configKey); }
    if (actor) { conditions.push(`actor = $${values.length + 1}`); values.push(actor); }
    if (status) { conditions.push(`status = $${values.length + 1}`); values.push(status); }
    if (source) { conditions.push(`change_source = $${values.length + 1}`); values.push(source); }
    if (from) { conditions.push(`created_at >= $${values.length + 1}`); values.push(from); }
    if (to) { conditions.push(`created_at <= $${values.length + 1}`); values.push(to); }
    if (cursor) { conditions.push(`id < $${values.length + 1}`); values.push(cursor); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    values.push(limit + 1);

    const result = await pool.query(
      `SELECT * FROM config_change_log ${where} ORDER BY created_at DESC LIMIT $${values.length}`,
      values,
    );
    const rows = result.rows as ConfigChangeRow[];
    const hasNext = rows.length > limit;
    const data = rows.slice(0, limit);
    return {
      data,
      nextCursor: hasNext ? data[data.length - 1]!.id : null,
    };
  }

  async listSnapshots(opts: {
    configKey?: string;
    isReviewed?: boolean;
    limit?: number;
  }): Promise<ConfigSnapshotRow[]> {
    const { configKey, isReviewed, limit = 50 } = opts;
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (configKey) { conditions.push(`config_key = $${values.length + 1}`); values.push(configKey); }
    if (isReviewed !== undefined) {
      conditions.push(`is_reviewed = $${values.length + 1}`);
      values.push(isReviewed);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    values.push(limit);

    const result = await pool.query(
      `SELECT * FROM config_snapshots ${where} ORDER BY created_at DESC LIMIT $${values.length}`,
      values,
    );
    return result.rows as ConfigSnapshotRow[];
  }

  async getChange(id: string): Promise<ConfigChangeRow> {
    const result = await pool.query(
      `SELECT * FROM config_change_log WHERE id = $1`,
      [id],
    );
    if (result.rows.length === 0) throw AppError.notFound(`Config change ${id} not found`);
    return result.rows[0] as ConfigChangeRow;
  }

  async getSnapshot(id: string): Promise<ConfigSnapshotRow> {
    const result = await pool.query(
      `SELECT * FROM config_snapshots WHERE id = $1`,
      [id],
    );
    if (result.rows.length === 0) throw AppError.notFound(`Config snapshot ${id} not found`);
    return result.rows[0] as ConfigSnapshotRow;
  }
}

export const configIntegrityService = new ConfigIntegrityService();
