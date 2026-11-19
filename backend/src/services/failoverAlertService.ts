import logger from '../utils/logger.js';
import { pool } from '../config/database.js';
import { notificationService } from './notificationService.js';
import { jobMetricsService } from './jobMetricsService.js';
import { auditLogService } from './auditLogService.js';

export interface FailoverEvent {
  timestamp: Date;
  type: 'failover_activated' | 'failover_deactivated' | 'connection_retry';
  details: {
    attempt?: number;
    backoffMs?: number;
    error?: string;
    isRead?: boolean;
  };
}

export type AlertSeverity = 'critical' | 'high' | 'medium' | 'low';

const SUPPORTED_SEVERITIES: ReadonlySet<AlertSeverity> = new Set([
  'critical',
  'high',
  'medium',
  'low',
]);

export interface AlertOwnership {
  sloKey: string;
  sloDefinition: string;
  owner: string;
  severity: AlertSeverity;
  runbookUrl: string;
  escalationRoute: string;
}

export interface FinancialSloAlert extends AlertOwnership {
  alertId: string;
  emittedAt: Date;
  acknowledgedAt: Date | null;
  recoveredAt: Date | null;
  details?: Record<string, unknown>;
}

export interface DrillRunResult {
  drillId: string;
  sloKey: string;
  idempotencyKey: string;
  status: 'completed' | 'failed';
  notificationDelivered: boolean;
  acknowledgementLatencyMs: number | null;
  recoveryLatencyMs: number | null;
  startedAt: Date;
  completedAt: Date;
  idempotentReplay: boolean;
}

const ownershipCache = new Map<string, AlertOwnership>();
const emittedAlerts = new Map<string, FinancialSloAlert>();
const drillRunsByIdempotencyKey = new Map<string, DrillRunResult>();

function isValidSeverity(value: string): value is AlertSeverity {
  return SUPPORTED_SEVERITIES.has(value as AlertSeverity);
}

export async function loadAlertOwnership(sloKey: string): Promise<AlertOwnership | null> {
  if (ownershipCache.has(sloKey)) {
    return ownershipCache.get(sloKey) as AlertOwnership;
  }

  const result = await pool.query(
    `SELECT slo_key, slo_definition, owner, severity, runbook_url, escalation_route
       FROM alert_ownership
      WHERE slo_key = $1`,
    [sloKey],
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];
  if (!isValidSeverity(row.severity)) {
    logger.error('Invalid alert severity in alert_ownership', {
      sloKey,
      severity: row.severity,
    });
    throw new Error(`Invalid severity '${row.severity}' for SLO '${sloKey}'`);
  }

  const ownership: AlertOwnership = {
    sloKey: row.slo_key,
    sloDefinition: row.slo_definition,
    owner: row.owner,
    severity: row.severity,
    runbookUrl: row.runbook_url,
    escalationRoute: row.escalation_route,
  };

  ownershipCache.set(sloKey, ownership);
  return ownership;
}

export function clearAlertOwnershipCache(): void {
  ownershipCache.clear();
}

export async function emitFinancialSloAlert(
  sloKey: string,
  details?: Record<string, unknown>,
): Promise<FinancialSloAlert> {
  const ownership = await loadAlertOwnership(sloKey);
  if (!ownership) {
    throw new Error(`Unknown SLO key '${sloKey}'`);
  }

  const alert: FinancialSloAlert = {
    ...ownership,
    alertId: `${sloKey}:${Date.now()}`,
    emittedAt: new Date(),
    acknowledgedAt: null,
    recoveredAt: null,
    details,
  };

  emittedAlerts.set(alert.alertId, alert);

  jobMetricsService.incrementCounter('financial_slo_alerts_emitted', 1, {
    sloKey,
    severity: ownership.severity,
    owner: ownership.owner,
  });

  await auditLogService.log({
    action: 'financial_slo_alert_emitted',
    resourceType: 'financial_slo_alert',
    resourceId: alert.alertId,
    metadata: {
      sloKey,
      severity: ownership.severity,
      owner: ownership.owner,
      runbookUrl: ownership.runbookUrl,
      escalationRoute: ownership.escalationRoute,
    },
  });

  return alert;
}

export function acknowledgeFinancialSloAlert(
  alertId: string,
  acknowledgedBy: string,
): FinancialSloAlert {
  const alert = emittedAlerts.get(alertId);
  if (!alert) {
    throw new Error(`Unknown alert '${alertId}'`);
  }
  if (alert.acknowledgedAt) {
    return alert;
  }

  alert.acknowledgedAt = new Date();
  emittedAlerts.set(alertId, alert);

  jobMetricsService.observeHistogram(
    'financial_slo_alert_ack_latency_ms',
    alert.acknowledgedAt.getTime() - alert.emittedAt.getTime(),
    { sloKey: alert.sloKey, severity: alert.severity },
  );

  void auditLogService.log({
    action: 'financial_slo_alert_acknowledged',
    resourceType: 'financial_slo_alert',
    resourceId: alertId,
    actor: acknowledgedBy,
    metadata: { sloKey: alert.sloKey },
  });

  return alert;
}

export function recoverFinancialSloAlert(alertId: string): FinancialSloAlert {
  const alert = emittedAlerts.get(alertId);
  if (!alert) {
    throw new Error(`Unknown alert '${alertId}'`);
  }
  if (alert.recoveredAt) {
    return alert;
  }

  alert.recoveredAt = new Date();
  emittedAlerts.set(alertId, alert);

  jobMetricsService.observeHistogram(
    'financial_slo_alert_recovery_latency_ms',
    alert.recoveredAt.getTime() - alert.emittedAt.getTime(),
    { sloKey: alert.sloKey, severity: alert.severity },
  );

  void auditLogService.log({
    action: 'financial_slo_alert_recovered',
    resourceType: 'financial_slo_alert',
    resourceId: alertId,
    metadata: { sloKey: alert.sloKey },
  });

  return alert;
}

export async function runDrill(
  sloKey: string,
  idempotencyKey: string,
): Promise<DrillRunResult> {
  if (!idempotencyKey) {
    throw new Error('idempotencyKey is required');
  }

  const existing = drillRunsByIdempotencyKey.get(idempotencyKey);
  if (existing) {
    return { ...existing, idempotentReplay: true };
  }

  const ownership = await loadAlertOwnership(sloKey);
  if (!ownership) {
    throw new Error(`Unknown SLO key '${sloKey}'`);
  }
  if (!isValidSeverity(ownership.severity)) {
    throw new Error(`Invalid severity '${ownership.severity}' for SLO '${sloKey}'`);
  }

  const startedAt = new Date();
  let notificationDelivered = false;
  let acknowledgementLatencyMs: number | null = null;
  let recoveryLatencyMs: number | null = null;
  let status: 'completed' | 'failed' = 'completed';

  try {
    await notificationService.send({
      channel: 'slo-drill',
      recipient: ownership.owner,
      severity: ownership.severity,
      title: `[DRILL] ${ownership.sloDefinition}`,
      body: `Scheduled drill for SLO '${sloKey}'. Runbook: ${ownership.runbookUrl}. Escalation: ${ownership.escalationRoute}.`,
      metadata: { sloKey, idempotencyKey, drill: true },
    });
    notificationDelivered = true;

    const acknowledgedAt = new Date();
    acknowledgementLatencyMs = acknowledgedAt.getTime() - startedAt.getTime();
    const recoveredAt = new Date();
    recoveryLatencyMs = recoveredAt.getTime() - startedAt.getTime();
  } catch (error) {
    status = 'failed';
    logger.error('SLO drill notification failed', { sloKey, idempotencyKey, error });
  }

  const completedAt = new Date();
  const drillId = `drill:${sloKey}:${idempotencyKey}`;

  const result: DrillRunResult = {
    drillId,
    sloKey,
    idempotencyKey,
    status,
    notificationDelivered,
    acknowledgementLatencyMs,
    recoveryLatencyMs,
    startedAt,
    completedAt,
    idempotentReplay: false,
  };

  await pool.query(
    `INSERT INTO slo_drill_runs
       (drill_id, slo_key, idempotency_key, status, notification_delivered,
        acknowledgement_latency_ms, recovery_latency_ms, started_at, completed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [
      drillId,
      sloKey,
      idempotencyKey,
      status,
      notificationDelivered,
      acknowledgementLatencyMs,
      recoveryLatencyMs,
      startedAt,
      completedAt,
    ],
  );

  drillRunsByIdempotencyKey.set(idempotencyKey, result);

  jobMetricsService.incrementCounter('financial_slo_drill_runs_total', 1, {
    sloKey,
    severity: ownership.severity,
    status,
  });
  if (acknowledgementLatencyMs !== null) {
    jobMetricsService.observeHistogram(
      'financial_slo_drill_ack_latency_ms',
      acknowledgementLatencyMs,
      { sloKey, severity: ownership.severity },
    );
  }
  if (recoveryLatencyMs !== null) {
    jobMetricsService.observeHistogram(
      'financial_slo_drill_recovery_latency_ms',
      recoveryLatencyMs,
      { sloKey, severity: ownership.severity },
    );
  }

  await auditLogService.log({
    action: 'financial_slo_drill_run',
    resourceType: 'financial_slo_drill',
    resourceId: drillId,
    metadata: {
      sloKey,
      idempotencyKey,
      status,
      notificationDelivered,
      acknowledgementLatencyMs,
      recoveryLatencyMs,
      owner: ownership.owner,
      escalationRoute: ownership.escalationRoute,
    },
  });

  return result;
}

const failoverEvents: FailoverEvent[] = [];
const MAX_EVENTS = 100;

export function recordFailoverEvent(event: Omit<FailoverEvent, 'timestamp'>): void {
  const failoverEvent: FailoverEvent = {
    timestamp: new Date(),
    ...event,
  };

  failoverEvents.push(failoverEvent);
  if (failoverEvents.length > MAX_EVENTS) {
    failoverEvents.shift();
  }

  switch (event.type) {
    case 'failover_activated':
      logger.error('DATABASE FAILOVER ACTIVATED', {
        timestamp: failoverEvent.timestamp.toISOString(),
        details: event.details,
      });
      sendFailoverAlert(failoverEvent);
      break;

    case 'failover_deactivated':
      logger.warn('Database failover deactivated - primary recovered', {
        timestamp: failoverEvent.timestamp.toISOString(),
      });
      sendFailoverRecoveryAlert(failoverEvent);
      break;

    case 'connection_retry':
      logger.debug('Database connection retry', {
        attempt: event.details.attempt,
        backoffMs: event.details.backoffMs,
      });
      break;
  }
}

export function getFailoverEvents(limit: number = 50): FailoverEvent[] {
  return failoverEvents.slice(-limit);
}

export function isCurrentlyFailingOver(): boolean {
  if (failoverEvents.length === 0) return false;
  const lastEvent = failoverEvents[failoverEvents.length - 1];
  return lastEvent.type === 'failover_activated';
}

async function sendFailoverAlert(event: FailoverEvent): Promise<void> {
  const webhookUrl = process.env.FAILOVER_ALERT_WEBHOOK;
  if (!webhookUrl) {
    logger.debug('No failover webhook configured');
    return;
  }

  let ownership: AlertOwnership | null = null;
  try {
    ownership = await loadAlertOwnership('database_failover');
  } catch (error) {
    logger.error('Failed to load alert ownership for database_failover', { error });
  }

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        severity: ownership?.severity ?? 'critical',
        title: 'Database Failover Activated',
        description: `Primary database connection failed. Failover to replica activated at ${event.timestamp.toISOString()}`,
        owner: ownership?.owner,
        runbookUrl: ownership?.runbookUrl,
        escalationRoute: ownership?.escalationRoute,
        sloDefinition: ownership?.sloDefinition,
        details: event.details,
      }),
    });

    if (!response.ok) {
      logger.error('Failover alert webhook failed', { status: response.status });
    }
  } catch (error) {
    logger.error('Failed to send failover alert', { error });
  }
}

async function sendFailoverRecoveryAlert(event: FailoverEvent): Promise<void> {
  const webhookUrl = process.env.FAILOVER_ALERT_WEBHOOK;
  if (!webhookUrl) {
    return;
  }

  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        severity: 'info',
        title: 'Database Failover Deactivated',
        description: `Primary database recovered at ${event.timestamp.toISOString()}. Failover mode disabled.`,
      }),
    });
  } catch (error) {
    logger.debug('Failed to send recovery alert', { error });
  }
}
