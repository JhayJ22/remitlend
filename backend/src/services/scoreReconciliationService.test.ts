import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  scoreReconciliationService,
  SCORE_DRIFT_ALERT_THRESHOLD,
} from './scoreReconciliationService';

describe('scoreReconciliationService', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reconciles all users and emits a summary log', async () => {
    const summary = await scoreReconciliationService.reconcileAll();

    expect(summary).toHaveProperty('usersChecked');
    expect(summary).toHaveProperty('drifted');
    expect(summary).toHaveProperty('corrected');
    expect(summary).toHaveProperty('failed');
  });

  it('fires an alert when drift exceeds the threshold', async () => {
    const alertSpy = vi.spyOn(scoreReconciliationService, 'fireAlert');
    const ledgerSpy = vi.spyOn(scoreReconciliationService, 'recordDiscrepancy');

    const drift = SCORE_DRIFT_ALERT_THRESHOLD + 1;

    await scoreReconciliationService.reconcileUser({
      userId: 'user-drift-above',
      dbScore: 100,
      onChainScore: 100 + drift,
    });

    expect(ledgerSpy).toHaveBeenCalledTimes(1);
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(alertSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-drift-above',
        drift,
      }),
    );
  });

  it('does not fire an alert when drift is within the threshold', async () => {
    const alertSpy = vi.spyOn(scoreReconciliationService, 'fireAlert');
    const ledgerSpy = vi.spyOn(scoreReconciliationService, 'recordDiscrepancy');

    const drift = SCORE_DRIFT_ALERT_THRESHOLD - 1;

    await scoreReconciliationService.reconcileUser({
      userId: 'user-drift-within',
      dbScore: 100,
      onChainScore: 100 + drift,
    });

    expect(ledgerSpy).not.toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('runs nightly via the scheduled cron job', async () => {
    vi.useFakeTimers();
    const reconcileSpy = vi.spyOn(scoreReconciliationService, 'reconcileAll');

    scoreReconciliationService.startNightlyJob();

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);

    expect(reconcileSpy).toHaveBeenCalled();

    scoreReconciliationService.stopNightlyJob();
  });
});
