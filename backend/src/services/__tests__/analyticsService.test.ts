import { describe, it, expect, jest } from '@jest/globals';

const mockQuery = jest.fn<(sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>>();
jest.unstable_mockModule('../../db/connection.js', () => ({ query: mockQuery }));

const { computeProtocolStats } = await import('../analyticsService.js');
const { CacheKeys } = await import('../../utils/cacheKeys.js');

describe('computeProtocolStats', () => {
  it('returns all four metric types', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('GROUP BY status')) return { rows: [{ status: 'active', count: 3 }] };
      if (sql.includes('date_trunc'))
        return {
          rows: [{ ts: new Date('2026-01-01T00:00:00Z'), total_originated: '1000.5', total_repaid: '10' }],
        };
      if (sql.includes('LATERAL')) return { rows: [{ corridor: 'USD-NGN', rate: 0.25 }] };
      return { rows: [{ b: 1, count: 4 }] };
    });
    const stats = await computeProtocolStats(new Date('2026-01-01'), new Date('2026-02-01'), 'week');
    expect(stats.loansByStatus).toEqual({ active: 3 });
    expect(stats.volumeByBucket[0]).toEqual({
      timestamp: '2026-01-01T00:00:00.000Z',
      totalOriginated: '1000.5',
      totalRepaid: '10',
    });
    expect(stats.defaultRateByCorridor).toEqual({ 'USD-NGN': 0.25 });
    expect(stats.scoreDistribution.map((b) => b.bucket)).toEqual(['300-499', '500-649', '650-799', '800-850']);
    expect(stats.scoreDistribution[1]?.count).toBe(4);
    expect(mockQuery.mock.calls.some(([sql]) => sql.includes("date_trunc('week'"))).toBe(true);
  });

  it('rejects an unknown bucket (no SQL injection)', async () => {
    await expect(
      computeProtocolStats(new Date(), new Date(), "day'); DROP TABLE x;--" as never),
    ).rejects.toThrow();
  });

  it('cache key includes from, to and bucket', () => {
    expect(CacheKeys.protocolStats('a', 'b', 'day')).toBe('analytics:protocol-stats:a:b:day');
    expect(CacheKeys.protocolStats('a', 'b', 'week')).not.toBe(CacheKeys.protocolStats('a', 'b', 'day'));
  });
});
