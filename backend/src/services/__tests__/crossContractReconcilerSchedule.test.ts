import { describe, it, expect, jest, beforeEach } from '@jest/globals';

type QueryResult = { rows: Record<string, unknown>[]; rowCount: number };
const mockQuery = jest.fn<(sql: string, params?: unknown[]) => Promise<QueryResult>>();
const mockAlert = jest.fn<(a: unknown) => Promise<void>>().mockResolvedValue(undefined);

jest.unstable_mockModule('../../db/connection.js', () => ({ query: mockQuery }));
jest.unstable_mockModule('../scoresService.js', () => ({ setAbsoluteUserScoresBulk: jest.fn() }));
jest.unstable_mockModule('../sorobanService.js', () => ({ sorobanService: {} }));
jest.unstable_mockModule('../jobMetricsService.js', () => ({
  jobMetricsService: { recordSuccess: jest.fn(), recordFailure: jest.fn() },
}));
jest.unstable_mockModule('../failoverAlertService.js', () => ({ emitCriticalAlert: mockAlert }));

const mod = await import('../crossContractReconciler.js');

/** One unresolved repay row that never matches a score event => half_applied each run. */
function divergent() {
  mockQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('/* fetch-unresolved */'))
      return {
        rows: [
          {
            id: 1,
            intent_key: 'k',
            borrower: 'GB',
            operation: 'repay',
            disbursement_ledger: 1,
            expected_score_delta: 5,
            attempts: 5,
            state: 'half_applied',
          },
        ],
        rowCount: 1,
      };
    return { rows: [], rowCount: 0 };
  });
}

const auditInserts = () =>
  mockQuery.mock.calls.filter(([sql]) => sql.includes('INSERT INTO audit_logs'));

describe('scheduled reconciliation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mod.resetReconcilerState();
    delete process.env.RECONCILER_CRON_SCHEDULE;
  });

  it('records an audit_logs row per run and alerts only after >2 consecutive divergent runs', async () => {
    divergent();
    await mod.runScheduledReconciliation();
    await mod.runScheduledReconciliation();
    expect(auditInserts()).toHaveLength(2);
    expect(auditInserts()[0]![1]![1]).toBe('cross_contract_reconciliation');
    expect(mockAlert).not.toHaveBeenCalled();

    await mod.runScheduledReconciliation();
    expect(mockAlert).toHaveBeenCalledTimes(1);
  });

  it('resets the streak when a run is clean', async () => {
    divergent();
    await mod.runScheduledReconciliation();
    await mod.runScheduledReconciliation();
    mockQuery.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
    await mod.runScheduledReconciliation();
    divergent();
    await mod.runScheduledReconciliation();
    expect(mockAlert).not.toHaveBeenCalled();
  });

  it('status endpoint data reflects the last audited run', async () => {
    mockQuery.mockImplementation(async () => ({
      rows: [
        {
          payload: { durationMs: 42, divergenceCount: 3, divergenceStreak: 2 },
          created_at: '2026-01-01T00:00:00.000Z',
        },
      ],
      rowCount: 1,
    }));
    const status = await mod.getReconciliationStatus();
    expect(status).toMatchObject({
      lastRunAt: '2026-01-01T00:00:00.000Z',
      durationMs: 42,
      divergenceCount: 3,
      schedule: '0 * * * *',
    });
  });

  it('fails startup validation for an invalid cron string', () => {
    process.env.RECONCILER_CRON_SCHEDULE = 'not a cron';
    expect(() => mod.startCrossContractReconciler()).toThrow(/Invalid RECONCILER_CRON_SCHEDULE/);
    process.env.RECONCILER_CRON_SCHEDULE = '*/5 * * * *';
    expect(() => mod.startCrossContractReconciler()).not.toThrow();
  });
});
