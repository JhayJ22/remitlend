import { query } from '../db/connection.js';
import { setAbsoluteUserScoresBulk } from './scoresService.js';
import { sorobanService } from './sorobanService.js';
import { recordScoreReconciliationRun } from '../middleware/metrics.js';
import { jobMetricsService } from './jobMetricsService.js';
import logger from '../utils/logger.js';

interface ActiveBorrowerScoreRow {
  address: string;
  dbScore: number | null;
}

export interface ScoreDivergence {
  address: string;
  dbScore: number | null;
  contractScore: number;
  absoluteDifference: number | null;
}

export interface ScoreReconciliationResult {
  activeBorrowerCount: number;
  checkedBorrowerCount: number;
  failedBorrowerCount: number;
  divergenceCount: number;
  correctedCount: number;
  autoCorrectEnabled: boolean;
  autoCorrectThreshold: number;
  divergences: ScoreDivergence[];
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

class ScoreReconciliationService {
  private getBatchSize(): number {
    return parsePositiveInt(process.env.SCORE_RECONCILIATION_BATCH_SIZE, 25);
  }

  private getMaxBorrowersPerRun(): number {
    return parsePositiveInt(process.env.SCORE_RECONCILIATION_MAX_BORROWERS_PER_RUN, 500);
  }

  private isAutoCorrectEnabled(): boolean {
    return parseBoolean(process.env.SCORE_RECONCILIATION_AUTOCORRECT_ENABLED, false);
  }

  private getAutoCorrectThreshold(): number {
    return parseNonNegativeInt(process.env.SCORE_RECONCILIATION_AUTOCORRECT_THRESHOLD, 50);
  }

  private getDriftAlertThreshold(): number {
    return parseNonNegativeInt(process.env.SCORE_DRIFT_ALERT_THRESHOLD, 50);
  }

  private async fetchActiveBorrowerScores(): Promise<ActiveBorrowerScoreRow[]> {
    const result = await query(
      `
      WITH active_loans AS (
        SELECT approved.loan_id, approved.address
        FROM contract_events approved
        WHERE approved.event_type = 'LoanApproved'
          AND approved.loan_id IS NOT NULL
          AND approved.address IS NOT NULL
          AND approved.address <> ''
          AND NOT EXISTS (
            SELECT 1
            FROM contract_events e
            WHERE e.loan_id = approved.loan_id
              AND e.event_type IN ('LoanRepaid', 'LoanDefaulted')
          )
      )
      SELECT DISTINCT
        a.address,
        s.current_score
      FROM active_loans a
      LEFT JOIN scores s ON s.user_id = a.address
      ORDER BY a.address ASC
      LIMIT $1
      `,
      [this.getMaxBorrowersPerRun()],
    );

    return result.rows.map((row) => {
      const record = row as {
        address?: string;
        current_score?: number | string | null;
      };

      return {
        address: String(record.address ?? ''),
        dbScore:
          record.current_score === null || record.current_score === undefined
            ? null
            : Number(record.current_score),
      };
    });
  }

  private async recordDiscrepancy(divergence: ScoreDivergence): Promise<void> {
    await query(
      `
      INSERT INTO score_discrepancies (
        user_id, db_score, contract_score, absolute_difference, detected_at
      ) VALUES ($1, $2, $3, $4, NOW())
      `,
      [
        divergence.address,
        divergence.dbScore,
        divergence.contractScore,
        divergence.absoluteDifference,
      ],
    );
  }

  async reconcileActiveBorrowerScores(): Promise<ScoreReconciliationResult> {
    const startTime = Date.now();
    const jobName = 'scoreReconciliationService';

    const activeBorrowers = await this.fetchActiveBorrowerScores();
    const batchSize = this.getBatchSize();
    const autoCorrectEnabled = this.isAutoCorrectEnabled();
    const autoCorrectThreshold = this.getAutoCorrectThreshold();
    const driftAlertThreshold = this.getDriftAlertThreshold();
    const divergences: ScoreDivergence[] = [];
    const corrections = new Map<string, number>();
    let checkedBorrowerCount = 0;
    let failedBorrowerCount = 0;
    let alertCount = 0;

    logger.withContext().info('score_reconciliation.run.start', {
      activeBorrowerCount: activeBorrowers.length,
      batchSize,
      autoCorrectEnabled,
      autoCorrectThreshold,
      driftAlertThreshold,
    });

    try {
      for (const batch of chunk(activeBorrowers, batchSize)) {
        const batchResults = await Promise.allSettled(
          batch.map(async (borrowerRow) => {
            const contractScore = await sorobanService.getOnChainCreditScore(borrowerRow.address);
            return {
              ...borrowerRow,
              contractScore,
            };
          }),
        );

        batchResults.forEach((result, index) => {
          const address = batch[index]?.address ?? 'unknown';
          if (result.status === 'rejected') {
            failedBorrowerCount += 1;
            logger.withContext().error('score_reconciliation.borrower.failed', {
              address,
              error: result.reason,
            });
            return;
          }

          checkedBorrowerCount += 1;
          const { dbScore, contractScore } = result.value;
          const absoluteDifference = dbScore === null ? null : Math.abs(contractScore - dbScore);
          const isDivergent = dbScore === null || dbScore !== contractScore;

          if (!isDivergent) {
            return;
          }

          const divergence: ScoreDivergence = {
            address,
            dbScore,
            contractScore,
            absoluteDifference,
          };
          divergences.push(divergence);

          logger.withContext().warn('score_reconciliation.mismatch', divergence);

          const exceedsAlertThreshold =
            absoluteDifference === null || absoluteDifference > driftAlertThreshold;

          if (exceedsAlertThreshold) {
            alertCount += 1;
            logger.withContext().error('score_reconciliation.drift.alert', {
              address,
              dbScore,
              contractScore,
              absoluteDifference,
              driftAlertThreshold,
            });
          }

          const exceedsThreshold =
            absoluteDifference === null || absoluteDifference >= autoCorrectThreshold;

          if (autoCorrectEnabled && exceedsThreshold) {
            corrections.set(address, contractScore);
          }
        });
      }

      logger.withContext().info('score_divergence_count', {
        metric: 'score_divergence_count',
        value: divergences.length,
      });

      if (divergences.length > 0) {
        await Promise.allSettled(
          divergences.map((divergence) => this.recordDiscrepancy(divergence)),
        );
      }

      if (corrections.size > 0) {
        await setAbsoluteUserScoresBulk(corrections);
        logger.withContext().warn('score_reconciliation.autocorrect.applied', {
          correctedCount: corrections.size,
          threshold: autoCorrectThreshold,
        });
      }

      const result: ScoreReconciliationResult = {
        activeBorrowerCount: activeBorrowers.length,
        checkedBorrowerCount,
        failedBorrowerCount,
        divergenceCount: divergences.length,
        correctedCount: corrections.size,
        autoCorrectEnabled,
        autoCorrectThreshold,
        divergences,
      };

      logger.withContext().info('score_reconciliation.run.complete', {
        usersChecked: result.checkedBorrowerCount,
        usersDrifted: result.divergenceCount,
        usersCorrected: result.correctedCount,
        usersFailed: result.failedBorrowerCount,
        alertCount,
        driftAlertThreshold,
      });
      recordScoreReconciliationRun();

      // Record success metrics
      const durationMs = Date.now() - startTime;
      jobMetricsService.recordSuccess(jobName, durationMs);

      return result;
    } catch (error) {
      // Record failure metrics
      const durationMs = Date.now() - startTime;
      jobMetricsService.recordFailure(jobName, error as Error | string, durationMs);
      throw error;
    }
  }
}

export const scoreReconciliationService = new ScoreReconciliationService();

let reconciliationInterval: ReturnType<typeof setInterval> | undefined;
let reconciliationInFlight = false;

export function startScoreReconciliationScheduler(): void {
  if (reconciliationInterval) return;

  if (process.env.NODE_ENV === 'test') {
    return;
  }

  if (!process.env.REMITTANCE_NFT_CONTRACT_ID) {
    logger.withContext().warn('score_reconciliation.scheduler.disabled', {
      reason: 'REMITTANCE_NFT_CONTRACT_ID not configured',
    });
    return;
  }

  const intervalMs = parsePositiveInt(
    process.env.SCORE_RECONCILIATION_INTERVAL_MS,
    24 * 60 * 60 * 1000,
  );

  const run = async () => {
    if (reconciliationInFlight) {
      logger.withContext().warn('score_reconciliation.run.skipped', {
        reason: 'previous run still in flight',
      });
      return;
    }
    reconciliationInFlight = true;
    try {
      await scoreReconciliationService.reconcileActiveBorrowerScores();
    } catch (error) {
      logger.withContext().error('score_reconciliation.run.failed', { error });
    } finally {
      reconciliationInFlight = false;
    }
  };

  reconciliationInterval = setInterval(run, intervalMs);
  if (typeof reconciliationInterval.unref === 'function') {
    reconciliationInterval.unref();
  }

  logger.withContext().info('score_reconciliation.scheduler.started', { intervalMs });
}

export function stopScoreReconciliationScheduler(): void {
  if (reconciliationInterval) {
    clearInterval(reconciliationInterval);
    reconciliationInterval = undefined;
  }
}
