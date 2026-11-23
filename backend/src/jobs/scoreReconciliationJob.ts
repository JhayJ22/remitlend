import cron from 'node-cron';
import { scoreReconciliationService } from '../services/scoreReconciliationService';
import { logger } from '../utils/logger';

/**
 * Default drift threshold (in points) above which a discrepancy is considered
 * alert-worthy. Overridable via the SCORE_DRIFT_ALERT_THRESHOLD env var.
 */
export const DEFAULT_SCORE_DRIFT_ALERT_THRESHOLD = 50;

/**
 * Cron expression for the nightly reconciliation run (02:00 every day).
 */
export const NIGHTLY_SCORE_RECONCILIATION_CRON = '0 2 * * *';

export interface ScoreReconciliationSummary {
  usersChecked: number;
  drifted: number;
  corrected: number;
  failed: number;
}

export function getScoreDriftAlertThreshold(): number {
  const raw = process.env.SCORE_DRIFT_ALERT_THRESHOLD;
  if (raw === undefined || raw === '') {
    return DEFAULT_SCORE_DRIFT_ALERT_THRESHOLD;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : DEFAULT_SCORE_DRIFT_ALERT_THRESHOLD;
}

/**
 * Runs a single reconciliation pass. Delegates the on-chain vs DB comparison,
 * discrepancy-ledger writes, and alerting to the reconciliation service, then
 * emits a summary log entry for the run.
 */
export async function runScoreReconciliation(): Promise<ScoreReconciliationSummary> {
  const threshold = getScoreDriftAlertThreshold();

  try {
    const result = await scoreReconciliationService.reconcileAll({ alertThreshold: threshold });

    const summary: ScoreReconciliationSummary = {
      usersChecked: result.usersChecked,
      drifted: result.drifted,
      corrected: result.corrected,
      failed: result.failed,
    };

    logger.info('score_reconciliation_summary', {
      ...summary,
      alertThreshold: threshold,
    });

    return summary;
  } catch (error) {
    logger.error('score_reconciliation_run_failed', {
      alertThreshold: threshold,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

let scheduledTask: cron.ScheduledTask | null = null;

/**
 * Schedules the nightly score reconciliation job. Idempotent: repeated calls
 * will not register duplicate cron tasks.
 */
export function startScoreReconciliationJob(): cron.ScheduledTask {
  if (scheduledTask) {
    return scheduledTask;
  }

  scheduledTask = cron.schedule(NIGHTLY_SCORE_RECONCILIATION_CRON, () => {
    void runScoreReconciliation();
  });

  logger.info('score_reconciliation_job_scheduled', {
    cron: NIGHTLY_SCORE_RECONCILIATION_CRON,
  });

  return scheduledTask;
}

export function stopScoreReconciliationJob(): void {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
  }
}
