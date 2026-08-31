import { describe, it, expect, jest, beforeEach } from '@jest/globals';

type QueryResult = { rows: Record<string, unknown>[] };
const mockQuery = jest.fn<(sql: string, params?: unknown[]) => Promise<QueryResult>>();

jest.unstable_mockModule('../../db/connection.js', () => ({
  query: mockQuery,
}));

const { getAuditLogs } = await import('../auditLogService.js');

function rows(count: number, startId = 1) {
  return Array.from({ length: count }, (_, i) => ({
    id: startId + i,
    actor: `actor-${startId + i}`,
    action: 'loan.approve',
    created_at: new Date('2026-08-01T00:00:00.000Z'),
  }));
}

describe('auditLogService.getAuditLogs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('query construction', () => {
    it('selects with no WHERE clause when no filters are supplied', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await getAuditLogs({});

      const [sql, values] = mockQuery.mock.calls[0];
      expect(sql).not.toContain('WHERE');
      expect(sql).toContain('ORDER BY created_at DESC');
      // Only the limit placeholder (default 25 + 1) is bound.
      expect(values).toEqual([26]);
    });

    it('filters by actor', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await getAuditLogs({ actor: 'GADMIN' });

      const [sql, values] = mockQuery.mock.calls[0];
      expect(sql).toContain('WHERE actor = $1');
      expect(values).toEqual(['GADMIN', 26]);
    });

    it('filters by action', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await getAuditLogs({ action: 'loan.reject' });

      const [sql, values] = mockQuery.mock.calls[0];
      expect(sql).toContain('WHERE action = $1');
      expect(values).toEqual(['loan.reject', 26]);
    });

    it('combines multiple filters with AND and sequential placeholders', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await getAuditLogs({
        actor: 'GADMIN',
        action: 'loan.approve',
        from: '2026-01-01',
        to: '2026-02-01',
        cursor: '500',
      });

      const [sql, values] = mockQuery.mock.calls[0];
      expect(sql).toContain(
        'WHERE actor = $1 AND action = $2 AND created_at >= $3 AND created_at <= $4 AND id < $5',
      );
      expect(values).toEqual(['GADMIN', 'loan.approve', '2026-01-01', '2026-02-01', '500', 26]);
    });

    it('honours a custom limit and binds limit + 1 for look-ahead', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await getAuditLogs({ limit: 5 });

      const [sql, values] = mockQuery.mock.calls[0];
      expect(sql).toContain('LIMIT $1');
      expect(values).toEqual([6]);
    });
  });

  describe('pagination', () => {
    it('returns no nextCursor when the page is not full', async () => {
      mockQuery.mockResolvedValueOnce({ rows: rows(3) });

      const result = await getAuditLogs({ limit: 10 });

      expect(result.data).toHaveLength(3);
      expect(result.nextCursor).toBeNull();
    });

    it('trims the look-ahead row and exposes the last visible id as nextCursor', async () => {
      // limit 2 → service requests 3, gets 3 back → hasNext.
      mockQuery.mockResolvedValueOnce({ rows: rows(3) });

      const result = await getAuditLogs({ limit: 2 });

      expect(result.data).toHaveLength(2);
      expect(result.data.map((r) => (r as { id: number }).id)).toEqual([1, 2]);
      expect(result.nextCursor).toBe('2');
    });
  });

  describe('total count', () => {
    it('omits the COUNT query unless withTotal is true', async () => {
      mockQuery.mockResolvedValueOnce({ rows: rows(1) });

      const result = await getAuditLogs({});

      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(result.total).toBeUndefined();
    });

    it('runs a COUNT query and returns the numeric total when withTotal is true', async () => {
      mockQuery.mockResolvedValueOnce({ rows: rows(1) });
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '42' }] });

      const result = await getAuditLogs({ withTotal: true });

      expect(mockQuery).toHaveBeenCalledTimes(2);
      expect(mockQuery.mock.calls[1][0]).toContain('SELECT COUNT(*)');
      expect(result.total).toBe(42);
    });

    it('defaults the total to 0 when the COUNT row is missing', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await getAuditLogs({ withTotal: true });

      expect(result.total).toBe(0);
    });
  });

  describe('PII handling on retrieval', () => {
    // Redaction of sensitive payload fields happens at write time in
    // backend/src/middleware/auditLog.ts (covered by src/tests/auditLog.test.ts).
    // The retrieval path must never re-expand or mutate what was persisted.
    it('returns persisted (already-redacted) rows verbatim without un-masking', async () => {
      const stored = {
        id: 7,
        actor: 'GADMIN',
        action: 'auth.login',
        payload: { email: '[REDACTED]', token: '[REDACTED]', ip: '203.0.113.4' },
      };
      mockQuery.mockResolvedValueOnce({ rows: [stored] });

      const result = await getAuditLogs({});

      expect(result.data[0]).toEqual(stored);
      expect(JSON.stringify(result.data[0])).not.toContain('@');
    });
  });
});
