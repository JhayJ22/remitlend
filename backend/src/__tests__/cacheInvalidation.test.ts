import { jest, describe, it, expect, beforeEach } from '@jest/globals';

/**
 * Tests that each write path busts the correct cache keys.
 * Strategy: warm the mock cache with a sentinel value, trigger the write
 * helper, then assert the sentinel is gone (i.e. delete was called with the
 * right key).
 */

const mockDelete = jest.fn<(key: string) => Promise<void>>().mockResolvedValue(undefined);
const mockSet = jest
  .fn<(key: string, value: unknown) => Promise<void>>()
  .mockResolvedValue(undefined);
const mockGet = jest.fn<(key: string) => Promise<null>>().mockResolvedValue(null);
const mockInvalidateByPattern = jest
  .fn<(pattern: string) => Promise<number>>()
  .mockResolvedValue(0);

jest.unstable_mockModule('../services/cacheService.js', () => ({
  cacheService: {
    get: mockGet,
    set: mockSet,
    delete: mockDelete,
    ping: jest.fn<() => Promise<string>>().mockResolvedValue('ok'),
    invalidatePattern: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    invalidateByPattern: mockInvalidateByPattern,
  },
}));

const cacheKeysModule = await import('../utils/cacheKeys.js');
const {
  CacheKeys,
  CachePatterns,
  SCORE_CACHE_VERSION,
  invalidateOnRepay,
  invalidateOnLoanRequest,
  invalidateOnDeposit,
  invalidateOnWithdraw,
} = cacheKeysModule;
const { WRITE_INVALIDATIONS, CACHE_CONTRACTS } = await import('../utils/cacheContracts.js');

const BORROWER = 'Gborrower123';
const DEPOSITOR = 'GDEPOSITOR456';
const LOAN_ID = 42;

describe('cacheKeys helpers', () => {
  beforeEach(() => {
    mockDelete.mockClear();
    mockSet.mockClear();
    mockGet.mockClear();
    mockInvalidateByPattern.mockClear();
  });

  describe('CacheKeys generators', () => {
    it('poolStats returns a stable key', () => {
      expect(CacheKeys.poolStats()).toBe('pool:stats');
    });

    it('borrowerLoans encodes the borrower address', () => {
      expect(CacheKeys.borrowerLoans(BORROWER)).toBe(`borrower:loans:${BORROWER}`);
    });

    it('scoreBreakdown encodes the schema version and public key', () => {
      expect(CacheKeys.scoreBreakdown(BORROWER)).toBe(
        `score:breakdown:v${SCORE_CACHE_VERSION}:${BORROWER}`,
      );
    });
  });

  describe('invalidateOnRepay', () => {
    it('deletes pool stats, borrower loans, and score breakdown', async () => {
      await invalidateOnRepay(BORROWER, LOAN_ID);

      const deletedKeys = mockDelete.mock.calls.map((c) => c[0]);
      expect(deletedKeys).toContain(CacheKeys.poolStats());
      expect(deletedKeys).toContain(CacheKeys.borrowerLoans(BORROWER));
      expect(deletedKeys).toContain(CacheKeys.scoreBreakdown(BORROWER));
    });

    it('calls delete exactly 3 times', async () => {
      await invalidateOnRepay(BORROWER, LOAN_ID);
      expect(mockDelete).toHaveBeenCalledTimes(3);
    });
  });

  describe('invalidateOnLoanRequest', () => {
    it('deletes pool stats and borrower loans', async () => {
      await invalidateOnLoanRequest(BORROWER);

      const deletedKeys = mockDelete.mock.calls.map((c) => c[0]);
      expect(deletedKeys).toContain(CacheKeys.poolStats());
      expect(deletedKeys).toContain(CacheKeys.borrowerLoans(BORROWER));
    });

    it('calls delete exactly 2 times', async () => {
      await invalidateOnLoanRequest(BORROWER);
      expect(mockDelete).toHaveBeenCalledTimes(2);
    });
  });

  describe('invalidateOnDeposit', () => {
    it('deletes pool stats', async () => {
      await invalidateOnDeposit(DEPOSITOR);

      expect(mockDelete).toHaveBeenCalledWith(CacheKeys.poolStats());
    });

    it('calls delete exactly once', async () => {
      await invalidateOnDeposit(DEPOSITOR);
      expect(mockDelete).toHaveBeenCalledTimes(1);
    });
  });

  describe('invalidateOnWithdraw', () => {
    it('deletes pool stats', async () => {
      await invalidateOnWithdraw(DEPOSITOR);

      expect(mockDelete).toHaveBeenCalledWith(CacheKeys.poolStats());
    });

    it('calls delete exactly once', async () => {
      await invalidateOnWithdraw(DEPOSITOR);
      expect(mockDelete).toHaveBeenCalledTimes(1);
    });
  });

  describe('cache warm → write → recompute flow', () => {
    it('next get returns null after invalidateOnRepay flushes the key', async () => {
      // Simulate a warmed cache for borrower loans
      const cache: Record<string, unknown> = {
        [CacheKeys.borrowerLoans(BORROWER)]: { loans: [] },
      };

      mockGet.mockImplementation(async (key: string) => {
        return ((cache[key] as unknown) ?? null) as null;
      });
      mockDelete.mockImplementation(async (key: string) => {
        delete cache[key];
      });

      // Confirm warm
      expect(await mockGet(CacheKeys.borrowerLoans(BORROWER))).not.toBeNull();

      // Trigger write invalidation
      await invalidateOnRepay(BORROWER, LOAN_ID);

      // Cache entry should be gone; next read recomputes from DB
      expect(await mockGet(CacheKeys.borrowerLoans(BORROWER))).toBeNull();
    });
  });

  describe('write → GET invalidation matrix (#794)', () => {
    /** Representative key each cached GET reads, per resource. */
    const readKey: Record<string, { key?: string; pattern?: string }> = {
      pool_stats: { key: CacheKeys.poolStats() },
      borrower_loans: { key: CacheKeys.borrowerLoans(BORROWER) },
      score_response: { key: CacheKeys.scoreResponse(BORROWER) },
      score_breakdown: { key: CacheKeys.scoreBreakdown(BORROWER) },
      pool_share_price: { pattern: CachePatterns.poolSharePrice() },
      user_profile: { key: CacheKeys.userProfile(BORROWER) },
    };

    it('every resource with an API write has a write→GET mapping', () => {
      const mapped = new Set(WRITE_INVALIDATIONS.flatMap((w) => w.resources));
      for (const [resource, contract] of Object.entries(CACHE_CONTRACTS)) {
        if (contract.invalidationTrigger.startsWith('TTL expiry only')) continue;
        expect(mapped).toContain(resource);
      }
    });

    it.each(WRITE_INVALIDATIONS.map((w) => [w.write, w] as const))(
      '%s busts the keys its GETs read and leaves no stale entry',
      async (_name, w) => {
        const fn = (cacheKeysModule as Record<string, unknown>)[w.invalidator] as (
          ...args: unknown[]
        ) => Promise<void>;
        expect(typeof fn).toBe('function');
        expect(w.reads.length).toBeGreaterThan(0);

        // Warm cache for every key the write should bust.
        const cache = new Map<string, unknown>();
        for (const r of w.resources) {
          const k = readKey[r]?.key;
          if (k) cache.set(k, { warm: true });
        }
        cache.set('pool:share-price:TOKEN', { warm: true });
        mockGet.mockImplementation(async (k: string) => (cache.get(k) ?? null) as null);
        mockDelete.mockImplementation(async (k: string) => {
          cache.delete(k);
        });
        mockInvalidateByPattern.mockImplementation(async (p: string) => {
          const prefix = p.replace(/\*$/, '');
          let n = 0;
          for (const k of [...cache.keys()]) if (k.startsWith(prefix) && cache.delete(k)) n++;
          return n;
        });

        await fn(BORROWER, LOAN_ID);

        for (const r of w.resources) {
          const { key, pattern } = readKey[r] ?? {};
          if (key) expect(await mockGet(key)).toBeNull();
          if (pattern) {
            expect(mockInvalidateByPattern).toHaveBeenCalledWith(pattern);
            expect(await mockGet('pool:share-price:TOKEN')).toBeNull();
          }
        }
      },
    );
  });
});
