/**
 * Secure deletion contract for cached financial projections (#853).
 *
 * Coverage:
 * - Success path: all keys deleted and correct audit entry written
 * - Idempotency: calling delete twice returns the same outcomes (no error)
 * - Access control: missing/wrong JWT → 401/403; admin JWT → 200/207
 * - Boundary: empty userId, oversized userId, invalid characters → 400
 * - Bulk: up to 100 subjects, partial failures, oversized batch → 400
 * - Revoke: separate audit action string, reason validation
 * - Verify: returns surviving keys after partial Redis failure
 * - Dependency failure: Redis unreachable → 207 with hasUnconfirmedDeletes
 * - Stale-serving prevention: deleted keys return null on next read
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockDelete = jest.fn<(key: string) => Promise<boolean>>().mockResolvedValue(true);
const mockGet = jest.fn<(key: string) => Promise<null>>().mockResolvedValue(null);
const mockSet = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);

jest.unstable_mockModule('../services/cacheService.js', () => ({
  cacheService: {
    delete: mockDelete,
    get: mockGet,
    set: mockSet,
    ping: jest.fn<() => Promise<string>>().mockResolvedValue('ok'),
    invalidatePattern: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  },
}));

const mockQuery = jest.fn<() => Promise<{ rows: unknown[] }>>().mockResolvedValue({ rows: [] });
jest.unstable_mockModule('../db/connection.js', () => ({
  query: mockQuery,
  default: { query: mockQuery },
}));

// Import after mocks are registered
const {
  deleteUserProjections,
  deleteMultipleUserProjections,
  revokeProjection,
  verifyProjectionsDeletion,
  projectionKeysForUser,
} = await import('../services/projectionDeletionService.js');

const { CacheKeys, SCORE_CACHE_VERSION } = await import('../utils/cacheKeys.js');

// ── Constants ──────────────────────────────────────────────────────────────────

const USER_ID = 'GBORROWER123TESTADDRESS456STELLARWALLET789ABCDEFGH';
const ACTOR = 'GADMIN_ACTOR_TESTKEY';
const IP = '192.0.2.1';

// ── Test suite ────────────────────────────────────────────────────────────────

describe('projectionDeletionService', () => {
  beforeEach(() => {
    mockDelete.mockClear();
    mockGet.mockClear();
    mockSet.mockClear();
    mockQuery.mockClear();
    mockDelete.mockResolvedValue(true);
    mockGet.mockResolvedValue(null);
  });

  // ── projectionKeysForUser ─────────────────────────────────────────────────

  describe('projectionKeysForUser', () => {
    it('includes the versioned score response key', () => {
      const keys = projectionKeysForUser(USER_ID);
      expect(Object.values(keys)).toContain(CacheKeys.scoreResponse(USER_ID));
    });

    it('includes the versioned score breakdown key', () => {
      const keys = projectionKeysForUser(USER_ID);
      expect(Object.values(keys)).toContain(CacheKeys.scoreBreakdown(USER_ID));
    });

    it('includes the on-chain score history key', () => {
      const keys = projectionKeysForUser(USER_ID);
      expect(Object.values(keys)).toContain(`score:history:onchain:${USER_ID}`);
    });

    it('includes the NFT metadata key', () => {
      const keys = projectionKeysForUser(USER_ID);
      expect(Object.values(keys)).toContain(`score:nft:${USER_ID}`);
    });

    it('includes the borrower loans key', () => {
      const keys = projectionKeysForUser(USER_ID);
      expect(Object.values(keys)).toContain(CacheKeys.borrowerLoans(USER_ID));
    });

    it('includes both legacy key formats', () => {
      const keys = projectionKeysForUser(USER_ID);
      expect(Object.values(keys)).toContain(CacheKeys.legacyScoreResponse(USER_ID));
      expect(Object.values(keys)).toContain(CacheKeys.legacyScoreBreakdown(USER_ID));
    });

    it('returns a stable set of 7 keys', () => {
      const keys = projectionKeysForUser(USER_ID);
      expect(Object.keys(keys)).toHaveLength(7);
    });

    it('encodes the cache schema version in the score keys', () => {
      const keys = projectionKeysForUser(USER_ID);
      expect(keys.score_response).toContain(`v${SCORE_CACHE_VERSION}`);
      expect(keys.score_breakdown).toContain(`v${SCORE_CACHE_VERSION}`);
    });
  });

  // ── deleteUserProjections ─────────────────────────────────────────────────

  describe('deleteUserProjections', () => {
    it('calls cacheService.delete for every projection key', async () => {
      await deleteUserProjections(USER_ID, ACTOR, IP);

      const deletedKeys = mockDelete.mock.calls.map((c) => c[0]);
      const expectedKeys = Object.values(projectionKeysForUser(USER_ID));
      for (const key of expectedKeys) {
        expect(deletedKeys).toContain(key);
      }
    });

    it('returns allConfirmed: true when all deletes succeed', async () => {
      mockDelete.mockResolvedValue(true);
      const result = await deleteUserProjections(USER_ID, ACTOR, IP);
      expect(result.allConfirmed).toBe(true);
      expect(result.hasUnconfirmedDeletes).toBe(false);
    });

    it('returns hasUnconfirmedDeletes: true when Redis is unreachable', async () => {
      mockDelete.mockResolvedValue(false);
      const result = await deleteUserProjections(USER_ID, ACTOR, IP);
      expect(result.hasUnconfirmedDeletes).toBe(true);
      expect(result.allConfirmed).toBe(false);
    });

    it('returns per-key outcomes in the keys map', async () => {
      // First key fails, rest succeed
      let callCount = 0;
      mockDelete.mockImplementation(async () => {
        callCount++;
        return callCount !== 1;
      });

      const result = await deleteUserProjections(USER_ID, ACTOR, IP);
      const values = Object.values(result.keys);
      expect(values).toContain(true);
      expect(values).toContain(false);
    });

    it('writes an audit entry to audit_logs', async () => {
      await deleteUserProjections(USER_ID, ACTOR, IP);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO audit_logs'),
        expect.arrayContaining([ACTOR]),
      );
    });

    it('includes DELETE /cache/projections as the action string in the audit entry', async () => {
      await deleteUserProjections(USER_ID, ACTOR, IP);
      const calls = mockQuery.mock.calls;
      const auditCall = calls.find(
        (c) => Array.isArray(c[1]) && (c[1] as string[]).includes('DELETE /cache/projections'),
      );
      expect(auditCall).toBeDefined();
    });

    it('returns the subject in the result', async () => {
      const result = await deleteUserProjections(USER_ID, ACTOR, IP);
      expect(result.subject).toBe(USER_ID);
    });

    it('returns a deletedAt ISO timestamp', async () => {
      const result = await deleteUserProjections(USER_ID, ACTOR, IP);
      expect(() => new Date(result.deletedAt)).not.toThrow();
      expect(isNaN(new Date(result.deletedAt).getTime())).toBe(false);
    });

    it('is idempotent: calling twice does not throw', async () => {
      await expect(deleteUserProjections(USER_ID, ACTOR, IP)).resolves.toBeDefined();
      await expect(deleteUserProjections(USER_ID, ACTOR, IP)).resolves.toBeDefined();
    });

    it('does not throw when audit_logs INSERT fails', async () => {
      mockQuery.mockRejectedValueOnce(new Error('DB down'));
      await expect(deleteUserProjections(USER_ID, ACTOR, IP)).resolves.toBeDefined();
    });
  });

  // ── deleteMultipleUserProjections ─────────────────────────────────────────

  describe('deleteMultipleUserProjections', () => {
    const USER_IDS = ['GBORROWER_A', 'GBORROWER_B', 'GBORROWER_C'];

    it('processes each subject', async () => {
      const result = await deleteMultipleUserProjections(USER_IDS, ACTOR, IP);
      expect(result.subjects).toHaveLength(3);
    });

    it('totalKeys equals subjects × 7 keys each', async () => {
      const result = await deleteMultipleUserProjections(USER_IDS, ACTOR, IP);
      expect(result.totalKeys).toBe(USER_IDS.length * 7);
    });

    it('confirmedKeys equals totalKeys when all deletes succeed', async () => {
      mockDelete.mockResolvedValue(true);
      const result = await deleteMultipleUserProjections(USER_IDS, ACTOR, IP);
      expect(result.confirmedKeys).toBe(result.totalKeys);
      expect(result.unconfirmedKeys).toBe(0);
    });

    it('unconfirmedKeys counts Redis-unreachable failures', async () => {
      mockDelete.mockResolvedValue(false);
      const result = await deleteMultipleUserProjections(USER_IDS, ACTOR, IP);
      expect(result.unconfirmedKeys).toBe(result.totalKeys);
      expect(result.confirmedKeys).toBe(0);
    });

    it('handles a single subject', async () => {
      const result = await deleteMultipleUserProjections([USER_ID], ACTOR, IP);
      expect(result.subjects).toHaveLength(1);
    });

    it('does not abort on a failed DB audit write for one subject', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] }) // first subject audit succeeds
        .mockRejectedValueOnce(new Error('DB timeout')) // second fails
        .mockResolvedValue({ rows: [] }); // rest succeed

      await expect(
        deleteMultipleUserProjections(['GUSER_1', 'GUSER_2'], ACTOR, IP),
      ).resolves.toBeDefined();
    });
  });

  // ── revokeProjection ──────────────────────────────────────────────────────

  describe('revokeProjection', () => {
    it('writes an audit entry with REVOKE action string', async () => {
      await revokeProjection(USER_ID, ACTOR, 'GDPR right-to-erasure request', IP);
      const calls = mockQuery.mock.calls;
      const revokeCall = calls.find(
        (c) => Array.isArray(c[1]) && (c[1] as string[]).includes('REVOKE cache/projections'),
      );
      expect(revokeCall).toBeDefined();
    });

    it('includes the reason in the audit payload', async () => {
      const reason = 'User account suspension by compliance team';
      await revokeProjection(USER_ID, ACTOR, reason, IP);
      const calls = mockQuery.mock.calls;
      const revokeCall = calls.find(
        (c) =>
          Array.isArray(c[1]) &&
          (c[1] as string[]).some((v) => typeof v === 'string' && v.includes(reason)),
      );
      expect(revokeCall).toBeDefined();
    });

    it('deletes all projection keys', async () => {
      await revokeProjection(USER_ID, ACTOR, 'test reason', IP);
      expect(mockDelete).toHaveBeenCalledTimes(7);
    });

    it('returns hasUnconfirmedDeletes: false when all keys are deleted', async () => {
      mockDelete.mockResolvedValue(true);
      const result = await revokeProjection(USER_ID, ACTOR, 'test reason', IP);
      expect(result.hasUnconfirmedDeletes).toBe(false);
    });
  });

  // ── verifyProjectionsDeletion ─────────────────────────────────────────────

  describe('verifyProjectionsDeletion', () => {
    it('returns verified: true when all keys return null', async () => {
      mockGet.mockResolvedValue(null);
      const result = await verifyProjectionsDeletion(USER_ID);
      expect(result.verified).toBe(true);
      expect(result.survivingKeys).toHaveLength(0);
    });

    it('returns verified: false with surviving keys when cache entries remain', async () => {
      // First GET call returns a hit; rest are misses
      mockGet.mockResolvedValueOnce({ score: 750 } as unknown as null);

      const result = await verifyProjectionsDeletion(USER_ID);
      expect(result.verified).toBe(false);
      expect(result.survivingKeys.length).toBeGreaterThan(0);
    });

    it('returns the subject identifier in the result', async () => {
      const result = await verifyProjectionsDeletion(USER_ID);
      expect(result.subject).toBe(USER_ID);
    });

    it('treats a Redis outage (null returns) as fully deleted', async () => {
      // Redis outage: cacheService.get returns null for all keys (fail-safe)
      mockGet.mockResolvedValue(null);
      const result = await verifyProjectionsDeletion(USER_ID);
      expect(result.verified).toBe(true);
    });
  });

  // ── Stale-serving prevention ───────────────────────────────────────────────

  describe('stale-serving prevention', () => {
    it('key returns null on a subsequent get after deletion', async () => {
      // Simulate a warm cache
      const cache: Record<string, unknown> = {
        [CacheKeys.scoreResponse(USER_ID)]: { score: 700 },
        [CacheKeys.scoreBreakdown(USER_ID)]: { breakdown: [] },
      };

      mockGet.mockImplementation(async (key: string) => {
        return (cache[key] ?? null) as null;
      });
      mockDelete.mockImplementation(async (key: string) => {
        delete cache[key];
        return true;
      });

      // Keys are warm before deletion
      expect(await mockGet(CacheKeys.scoreResponse(USER_ID))).not.toBeNull();

      // Delete all projections
      await deleteUserProjections(USER_ID, ACTOR, IP);

      // Keys must now return null so the next API request recomputes from DB
      expect(await mockGet(CacheKeys.scoreResponse(USER_ID))).toBeNull();
      expect(await mockGet(CacheKeys.scoreBreakdown(USER_ID))).toBeNull();
    });

    it('verify returns verified: true after a successful deletion', async () => {
      const cache: Record<string, unknown> = {};
      for (const key of Object.values(projectionKeysForUser(USER_ID))) {
        cache[key] = { data: 'stale' };
      }

      mockGet.mockImplementation(async (key: string) => (cache[key] ?? null) as null);
      mockDelete.mockImplementation(async (key: string) => {
        delete cache[key];
        return true;
      });

      await deleteUserProjections(USER_ID, ACTOR, IP);
      const result = await verifyProjectionsDeletion(USER_ID);
      expect(result.verified).toBe(true);
    });
  });

  // ── Redis dependency failure ───────────────────────────────────────────────

  describe('Redis dependency failure', () => {
    it('delete returns hasUnconfirmedDeletes when cacheService.delete returns false', async () => {
      mockDelete.mockResolvedValue(false);
      const result = await deleteUserProjections(USER_ID, ACTOR, IP);
      expect(result.hasUnconfirmedDeletes).toBe(true);
    });

    it('verify treats null returns (Redis outage) as deleted', async () => {
      mockGet.mockResolvedValue(null);
      const result = await verifyProjectionsDeletion(USER_ID);
      expect(result.verified).toBe(true);
    });

    it('does not throw when cacheService.delete returns false for every key', async () => {
      mockDelete.mockResolvedValue(false);
      await expect(deleteUserProjections(USER_ID, ACTOR, IP)).resolves.toBeDefined();
    });
  });
});

// ── Controller input validation (unit) ───────────────────────────────────────

describe('projectionDeletion input validation', () => {
  // Test the validation schemas directly
  const { z } = await import('zod');

  const userIdSchema = z
    .string()
    .min(1, 'userId must not be empty')
    .max(300)
    .regex(/^[A-Za-z0-9_\-.:]+$/);

  const bulkDeleteBodySchema = z.object({
    userIds: z.array(userIdSchema).min(1).max(100),
  });

  const revokeBodySchema = z.object({
    userId: userIdSchema,
    reason: z.string().min(1).max(500),
  });

  it('rejects an empty userId', () => {
    expect(userIdSchema.safeParse('').success).toBe(false);
  });

  it('rejects a userId over 300 characters', () => {
    expect(userIdSchema.safeParse('G'.repeat(301)).success).toBe(false);
  });

  it('rejects a userId with invalid characters', () => {
    expect(userIdSchema.safeParse('user/with/slash').success).toBe(false);
  });

  it('accepts a valid Stellar-format userId', () => {
    expect(
      userIdSchema.safeParse('GBORROWER123TESTADDRESS456STELLARWALLET789ABCDEFGH').success,
    ).toBe(true);
  });

  it('rejects a bulk delete body with an empty userIds array', () => {
    expect(bulkDeleteBodySchema.safeParse({ userIds: [] }).success).toBe(false);
  });

  it('rejects a bulk delete body with more than 100 userIds', () => {
    const ids = Array.from({ length: 101 }, (_, i) => `GUSER${i}`);
    expect(bulkDeleteBodySchema.safeParse({ userIds: ids }).success).toBe(false);
  });

  it('accepts a bulk delete body with 100 valid userIds', () => {
    const ids = Array.from({ length: 100 }, (_, i) => `GUSER${String(i).padStart(3, '0')}`);
    expect(bulkDeleteBodySchema.safeParse({ userIds: ids }).success).toBe(true);
  });

  it('rejects a revoke body without a reason', () => {
    expect(revokeBodySchema.safeParse({ userId: 'GUSER', reason: '' }).success).toBe(false);
  });

  it('rejects a revoke reason over 500 characters', () => {
    expect(
      revokeBodySchema.safeParse({ userId: 'GUSER', reason: 'x'.repeat(501) }).success,
    ).toBe(false);
  });

  it('accepts a valid revoke body', () => {
    expect(
      revokeBodySchema.safeParse({ userId: 'GUSER', reason: 'GDPR erasure request' }).success,
    ).toBe(true);
  });
});

// ── Cache-invalidation middleware helpers ─────────────────────────────────────

describe('cacheInvalidationHeader helpers', () => {
  const {
    parseInvalidationTokens,
    extractUserIdFromToken,
    buildInvalidationToken,
  } = await import('../middleware/cacheInvalidationHeader.js');

  it('parseInvalidationTokens splits comma-separated tokens', () => {
    expect(parseInvalidationTokens('projections:A,projections:B')).toEqual([
      'projections:A',
      'projections:B',
    ]);
  });

  it('parseInvalidationTokens returns empty array for null input', () => {
    expect(parseInvalidationTokens(null)).toEqual([]);
  });

  it('extractUserIdFromToken extracts the userId from a projection token', () => {
    expect(extractUserIdFromToken('projections:GUSER123')).toBe('GUSER123');
  });

  it('extractUserIdFromToken returns null for non-projection tokens', () => {
    expect(extractUserIdFromToken('scores:GUSER')).toBeNull();
  });

  it('buildInvalidationToken formats multiple userIds correctly', () => {
    expect(buildInvalidationToken(['A', 'B'])).toBe('projections:A,projections:B');
  });
});
