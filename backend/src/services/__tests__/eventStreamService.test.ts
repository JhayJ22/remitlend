import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

jest.unstable_mockModule('../../utils/logger.js', () => ({
  default: {
    withContext: () => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    }),
  },
}));

const { eventStreamService } = await import('../eventStreamService.js');
type LoanEventPayload = Parameters<typeof eventStreamService.broadcast>[0];

interface FakeRes {
  write: jest.Mock;
  end: jest.Mock;
}

function makeRes(): FakeRes {
  return { write: jest.fn(), end: jest.fn() };
}

// The service's `Response` type is far wider than what it actually touches
// (only `.write` / `.end`), so a minimal fake is sufficient.
function asRes(res: FakeRes) {
  return res as unknown as Parameters<typeof eventStreamService.sendEvent>[0];
}

function makeEvent(overrides: Partial<LoanEventPayload> = {}): LoanEventPayload {
  return {
    eventId: 'evt-1',
    eventType: 'LoanFunded',
    loanId: 1,
    address: 'GBORROWER',
    amount: '1000000000',
    amountDisplay: '100.0000000',
    ledger: 42,
    ledgerClosedAt: '2026-08-01T00:00:00Z',
    txHash: 'abc123',
    ...overrides,
  };
}

describe('eventStreamService', () => {
  beforeEach(() => {
    eventStreamService.reset();
  });

  afterEach(() => {
    eventStreamService.reset();
    jest.useRealTimers();
  });

  describe('connection lifecycle', () => {
    it('tracks a borrower subscription in the connection counts', () => {
      const res = makeRes();
      eventStreamService.subscribeAddress('user-1', 'GBORROWER', asRes(res));

      expect(eventStreamService.getConnectionCount()).toEqual({
        borrower: 1,
        admin: 0,
        total: 1,
      });
      expect(eventStreamService.getUserConnectionCount('user-1')).toBe(1);
    });

    it('tracks an admin subscription separately', () => {
      const res = makeRes();
      eventStreamService.subscribeAll('admin-1', asRes(res));

      expect(eventStreamService.getConnectionCount()).toEqual({
        borrower: 0,
        admin: 1,
        total: 1,
      });
    });

    it('cleans up all state when the borrower unsubscribe fn is called', () => {
      const res = makeRes();
      const unsubscribe = eventStreamService.subscribeAddress('user-1', 'GBORROWER', asRes(res));

      unsubscribe();

      expect(eventStreamService.getConnectionCount().total).toBe(0);
      expect(eventStreamService.getUserConnectionCount('user-1')).toBe(0);
      expect(eventStreamService.canOpenConnection('user-1')).toBe(true);
    });

    it('cleans up admin state when the admin unsubscribe fn is called', () => {
      const res = makeRes();
      const unsubscribe = eventStreamService.subscribeAll('admin-1', asRes(res));

      unsubscribe();

      expect(eventStreamService.getConnectionCount().total).toBe(0);
      expect(eventStreamService.getUserConnectionCount('admin-1')).toBe(0);
    });

    it('does not leak between users sharing a borrower address', () => {
      const a = makeRes();
      const b = makeRes();
      const unsubA = eventStreamService.subscribeAddress('user-a', 'GSHARED', asRes(a));
      eventStreamService.subscribeAddress('user-b', 'GSHARED', asRes(b));

      unsubA();

      expect(eventStreamService.getUserConnectionCount('user-a')).toBe(0);
      expect(eventStreamService.getUserConnectionCount('user-b')).toBe(1);
      expect(eventStreamService.getConnectionCount().borrower).toBe(1);
    });
  });

  describe('per-user connection limiting', () => {
    it('allows up to the maximum connections per user then refuses more', () => {
      const max = eventStreamService.getMaxConnectionsPerUser();
      for (let i = 0; i < max; i += 1) {
        expect(eventStreamService.canOpenConnection('user-1')).toBe(true);
        eventStreamService.subscribeAddress('user-1', 'GBORROWER', asRes(makeRes()));
      }

      expect(eventStreamService.getUserConnectionCount('user-1')).toBe(max);
      expect(eventStreamService.canOpenConnection('user-1')).toBe(false);
    });

    it('frees a slot again once a connection unsubscribes', () => {
      const first = eventStreamService.subscribeAddress('user-1', 'GBORROWER', asRes(makeRes()));
      eventStreamService.subscribeAddress('user-1', 'GBORROWER', asRes(makeRes()));
      eventStreamService.subscribeAddress('user-1', 'GBORROWER', asRes(makeRes()));
      expect(eventStreamService.canOpenConnection('user-1')).toBe(false);

      first();

      expect(eventStreamService.canOpenConnection('user-1')).toBe(true);
    });
  });

  describe('broadcast', () => {
    it('writes a well-formed SSE frame to the matching borrower client', () => {
      const res = makeRes();
      eventStreamService.subscribeAddress('user-1', 'GBORROWER', asRes(res));

      eventStreamService.broadcast(makeEvent({ eventId: 'evt-9', address: 'GBORROWER' }));

      expect(res.write).toHaveBeenCalledTimes(1);
      const frame = res.write.mock.calls[0][0] as string;
      expect(frame).toContain('id: evt-9\n');
      expect(frame).toContain('event: loan-event\n');
      expect(frame).toContain('data: ');
      expect(frame.endsWith('\n\n')).toBe(true);
    });

    it('does not deliver to borrower clients subscribed to a different address', () => {
      const other = makeRes();
      eventStreamService.subscribeAddress('user-2', 'GOTHER', asRes(other));

      eventStreamService.broadcast(makeEvent({ address: 'GBORROWER' }));

      expect(other.write).not.toHaveBeenCalled();
    });

    it('fans out to every admin client regardless of address', () => {
      const admin1 = makeRes();
      const admin2 = makeRes();
      eventStreamService.subscribeAll('admin-1', asRes(admin1));
      eventStreamService.subscribeAll('admin-2', asRes(admin2));

      eventStreamService.broadcast(makeEvent({ address: 'GBORROWER' }));

      expect(admin1.write).toHaveBeenCalledTimes(1);
      expect(admin2.write).toHaveBeenCalledTimes(1);
    });

    it('evicts a client whose write throws instead of failing the broadcast', () => {
      const healthy = makeRes();
      const broken = makeRes();
      broken.write.mockImplementation(() => {
        throw new Error('EPIPE');
      });
      eventStreamService.subscribeAddress('user-1', 'GBORROWER', asRes(broken));
      eventStreamService.subscribeAddress('user-2', 'GBORROWER', asRes(healthy));

      expect(() => eventStreamService.broadcast(makeEvent({ address: 'GBORROWER' }))).not.toThrow();

      expect(healthy.write).toHaveBeenCalledTimes(1);
      expect(eventStreamService.getConnectionCount().borrower).toBe(1);
    });
  });

  describe('PII masking', () => {
    it('redacts known PII fields before serialising the SSE payload', () => {
      const res = makeRes();
      const event = makeEvent({
        recipient_email: 'alice@example.com',
        recipient_phone: '+15551234567',
        recipient_name: 'Alice Borrower',
        email: 'alice@example.com',
        phone: '+15551234567',
        legalName: 'Alice Q. Borrower',
      } as Partial<LoanEventPayload>);

      eventStreamService.sendEvent(asRes(res), event);

      const frame = res.write.mock.calls[0][0] as string;
      const data = JSON.parse(frame.split('data: ')[1].trim());
      for (const field of [
        'recipient_email',
        'recipient_phone',
        'recipient_name',
        'email',
        'phone',
        'legalName',
      ]) {
        expect(data[field]).toBe('[REDACTED]');
      }
      expect(frame).not.toContain('alice@example.com');
      expect(frame).not.toContain('Alice Borrower');
      // Non-PII fields are still present.
      expect(data.txHash).toBe('abc123');
      expect(data.amount).toBe('1000000000');
    });
  });

  describe('heartbeat', () => {
    it('pings every connected client on the heartbeat interval', () => {
      jest.useFakeTimers();
      const res = makeRes();
      eventStreamService.subscribeAddress('user-1', 'GBORROWER', asRes(res));

      jest.advanceTimersByTime(30_000);

      expect(res.write).toHaveBeenCalledWith(': ping\n\n');
    });

    it('stops the heartbeat timer once the last client disconnects', () => {
      jest.useFakeTimers();
      const res = makeRes();
      const unsubscribe = eventStreamService.subscribeAddress('user-1', 'GBORROWER', asRes(res));

      unsubscribe();
      res.write.mockClear();
      jest.advanceTimersByTime(60_000);

      expect(res.write).not.toHaveBeenCalled();
    });
  });

  describe('closeAllConnections', () => {
    it('sends a shutdown frame, ends every socket and clears all state', () => {
      const borrower = makeRes();
      const admin = makeRes();
      eventStreamService.subscribeAddress('user-1', 'GBORROWER', asRes(borrower));
      eventStreamService.subscribeAll('admin-1', asRes(admin));

      eventStreamService.closeAllConnections('maintenance');

      for (const res of [borrower, admin]) {
        const frame = res.write.mock.calls[0][0] as string;
        expect(frame).toContain('event: shutdown');
        expect(frame).toContain('maintenance');
        expect(res.end).toHaveBeenCalledTimes(1);
      }
      expect(eventStreamService.getConnectionCount().total).toBe(0);
    });
  });
});
