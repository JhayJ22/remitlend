/**
 * Retry-storm alerting for transaction submission (#857).
 *
 * Covers: an alert is raised on backpressure, the alert is deduplicated (a
 * second evaluation while still breaching does not re-emit), the alert
 * clears on recovery, and a DB failure during alert emission never breaks
 * evaluation (dependency-failure). The database is mocked and the write
 * queue uses an in-memory store so pending depth is deterministic.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

const mockQuery = jest.fn(async () => ({ rows: [] }));

jest.unstable_mockModule('../../db/connection.js', () => ({
  default: { query: mockQuery },
  query: mockQuery,
  getClient: jest.fn(),
  withTransaction: jest.fn(),
}));

const { sorobanCircuitBreaker } = await import('../sorobanCircuitBreaker.js');
const { resetNetworkRegistry } = await import('../../config/networks.js');
const {
  sorobanWriteQueue,
  InMemorySorobanWriteQueueStore,
} = await import('../sorobanWriteQueue.js');
const { isStormAlertActive, setStormAlertState } = await import(
  '../networkTelemetryService.js'
);
const { evaluateRetryStorm, resetRetryStormState } = await import(
  '../retryStormAlertService.js'
);

describe('Retry-storm alert service (#857)', () => {
  beforeEach(() => {
    sorobanCircuitBreaker.reset();
    resetNetworkRegistry();
    resetRetryStormState();
    setStormAlertState(false);
    sorobanWriteQueue.setStore(new InMemorySorobanWriteQueueStore());
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [] } as never);

    process.env.STELLAR_NETWORK = 'testnet';
    process.env.TX_SUBMISSION_STORM_PENDING_THRESHOLD = '2';
    process.env.TX_SUBMISSION_STORM_CONSECUTIVE_FAILURES = '10';
    process.env.TX_SUBMISSION_STORM_THROTTLE_RATE_THRESHOLD = '0.5';
    process.env.TX_SUBMISSION_STORM_EVAL_INTERVAL_MS = '0';
    process.env.TX_SUBMISSION_STORM_COOLDOWN_MS = '9999999';
  });

  afterEach(() => {
    delete process.env.TX_SUBMISSION_STORM_PENDING_THRESHOLD;
    delete process.env.TX_SUBMISSION_STORM_CONSECUTIVE_FAILURES;
    delete process.env.TX_SUBMISSION_STORM_THROTTLE_RATE_THRESHOLD;
    delete process.env.TX_SUBMISSION_STORM_EVAL_INTERVAL_MS;
    delete process.env.TX_SUBMISSION_STORM_COOLDOWN_MS;
  });

  async function enqueuePending(n: number) {
    for (let i = 0; i < n; i += 1) {
      await sorobanWriteQueue.enqueue({
        idempotencyKey: `submit:storm-${i}`,
        operation: 'submit_signed_tx',
        payload: { signedTxXdr: 'xdr' },
      });
    }
  }

  it('raises a single retry-storm alert when write-queue backpressure breaches the threshold', async () => {
    await enqueuePending(3); // pending=3 >= threshold 2

    const raised = await evaluateRetryStorm(true);
    expect(raised.transitionedTo).toBe('alert');
    expect(isStormAlertActive()).toBe(true);
    // One event persisted for the raise.
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('deduplicates: a second evaluation while still breaching does not re-emit', async () => {
    await enqueuePending(3);
    await evaluateRetryStorm(true);

    mockQuery.mockClear();
    const second = await evaluateRetryStorm(true);
    expect(second.transitionedTo).toBeNull();
    expect(isStormAlertActive()).toBe(true);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('clears the alert once backpressure resolves', async () => {
    await enqueuePending(3);
    await evaluateRetryStorm(true);
    expect(isStormAlertActive()).toBe(true);

    // Drain the queue.
    const ready = await sorobanWriteQueue.listReadyForReplay(10);
    for (const w of ready) await sorobanWriteQueue.markApplied(w.id);

    const cleared = await evaluateRetryStorm(true);
    expect(cleared.transitionedTo).toBe('recovered');
    expect(isStormAlertActive()).toBe(false);
  });

  it('does not alert when backpressure stays below the threshold (successful path)', async () => {
    await enqueuePending(1); // pending=1 < threshold 2
    const result = await evaluateRetryStorm(true);
    expect(result.transitionedTo).toBeNull();
    expect(isStormAlertActive()).toBe(false);
  });

  it('survives a DB failure during alert emission (dependency-failure)', async () => {
    await enqueuePending(3);
    // The event INSERT fails; evaluation must still resolve and raise the alert.
    mockQuery.mockRejectedValueOnce(new Error('db down') as never);

    await expect(evaluateRetryStorm(true)).resolves.toMatchObject({ transitionedTo: 'alert' });
    expect(isStormAlertActive()).toBe(true);
  });
});
