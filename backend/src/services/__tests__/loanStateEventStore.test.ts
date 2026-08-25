import { jest } from '@jest/globals';
import { describe, it, expect, beforeEach } from '@jest/globals';

type MockQueryResult = { rows: unknown[]; rowCount?: number };

const mockQuery: jest.MockedFunction<
  (text: string, params?: unknown[]) => Promise<MockQueryResult>
> = jest.fn();

jest.unstable_mockModule('../../db/connection.js', () => ({
  query: mockQuery,
  getClient: jest.fn(),
  closePool: jest.fn(),
  withTransaction: jest.fn(),
}));

const { foldLoanState, emitLoanStateEvent, getLoanStateEvents, replayLoanState } = await import(
  '../loanStateEventStore.js'
);

const event = (
  eventType: string,
  amount?: number,
  occurredAt: Date = new Date('2024-01-01T00:00:00Z'),
) => ({ eventType, amount, occurredAt, payload: { amount: amount ?? null }, actor: null, loanId: 1 });

describe('foldLoanState', () => {
  it('reconstructs an active loan from requested + approved + repaid events', () => {
    const snapshot = foldLoanState([
      event('LoanRequested', 1000),
      event('LoanApproved', 1000, new Date('2024-01-02T00:00:00Z')),
      event('LoanRepaid', 400, new Date('2024-01-03T00:00:00Z')),
    ]);

    expect(snapshot.status).toBe('active');
    expect(snapshot.principal).toBe(1000);
    expect(snapshot.totalRepaid).toBe(400);
    expect(snapshot.approved).toBe(true);
    expect(snapshot.eventCount).toBe(3);
  });

  it('marks a loan defaulted and overrides active status', () => {
    const snapshot = foldLoanState([
      event('LoanRequested', 1000),
      event('LoanApproved', 1000, new Date('2024-01-02T00:00:00Z')),
      event('LoanDefaulted', 0, new Date('2024-01-03T00:00:00Z')),
    ]);

    expect(snapshot.status).toBe('defaulted');
    expect(snapshot.defaulted).toBe(true);
  });

  it('reflects a dispute open state', () => {
    const snapshot = foldLoanState([
      event('LoanRequested', 1000),
      event('LoanDisputed', 0, new Date('2024-01-02T00:00:00Z')),
    ]);

    expect(snapshot.status).toBe('disputed');
    expect(snapshot.disputed).toBe(true);
  });

  it('treats cancellation as terminal', () => {
    const snapshot = foldLoanState([
      event('LoanRequested', 1000),
      event('LoanCancelled', 0, new Date('2024-01-02T00:00:00Z')),
      event('LoanApproved', 1000, new Date('2024-01-03T00:00:00Z')),
    ]);

    expect(snapshot.status).toBe('cancelled');
  });
});

describe('loanStateEventStore', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it('emitLoanStateEvent inserts with an explicit idempotent event_id', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 1, event_id: 'lse_x', loan_id: 1, event_type: 'LoanRequested', payload: {}, actor: null, occurred_at: new Date(), created_at: new Date() }],
      rowCount: 1,
    });

    const result = await emitLoanStateEvent({ loanId: 1, eventType: 'LoanRequested', eventId: 'lse_x' });
    expect(result).not.toBeNull();
    expect(mockQuery.mock.calls[0][0]).toContain('INSERT INTO loan_state_events');
  });

  it('replayLoanState falls back to contract_events when no domain events exist', async () => {
    // First call (getLoanStateEvents) returns nothing.
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // Fallback reads contract_events.
    mockQuery.mockResolvedValueOnce({
      rows: [
        { event_type: 'LoanRequested', amount: '500', ledger_closed_at: '2024-01-01T00:00:00Z', tx_hash: 't1' },
        { event_type: 'LoanApproved', amount: '500', ledger_closed_at: '2024-01-02T00:00:00Z', tx_hash: 't2' },
      ],
      rowCount: 2,
    });

    const snapshot = await replayLoanState(1);
    expect(snapshot.status).toBe('active');
    expect(snapshot.principal).toBe(500);
    expect(snapshot.eventCount).toBe(2);
  });
});
