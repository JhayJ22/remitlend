import { cacheService } from '../services/cacheService.js';

/**
 * Version marker for cached score read payloads.
 *
 * Bump this whenever the response shape of a score read endpoint changes. It is
 * embedded in the cache key (and in the stored envelope) so old entries become
 * unreachable immediately instead of being served against the new shape.
 */
export const SCORE_CACHE_VERSION = 1;

/**
 * Canonical cache key generators.
 * Each read key that populates a cache entry is paired here with the
 * write operations that must bust it so the mapping is testable in isolation.
 *
 * IMPORTANT: The exact string format returned by each function is part of the
 * runtime contract between this module and the data in Redis.  If a format
 * is changed, existing cached entries under the old format become orphaned
 * and will never be evicted unless a deployment runbook step explicitly
 * flushes the affected keys.  Always add a cache flush step to the deploy
 * runbook when modifying a key format.
 */
export const CacheKeys = {
  // Pool stats aggregate (getPoolStats)
  poolStats: () => 'pool:stats',

  // Per-borrower loans aggregate (getBorrowerLoans)
  borrowerLoans: (borrower: string) => `borrower:loans:${borrower}`,

  /**
   * Versioned per-user credit score (GET /score/:userId), served through the
   * stale-while-revalidate middleware.
   */
  scoreResponse: (userId: string) => `score:response:v${SCORE_CACHE_VERSION}:${userId}`,

  /**
   * Versioned per-user score breakdown (GET /score/:userId/breakdown), served
   * through the stale-while-revalidate middleware.
   */
  scoreBreakdown: (publicKey: string) => `score:breakdown:v${SCORE_CACHE_VERSION}:${publicKey}`,

  // Pre-versioning key formats. Nothing reads these any more; they are kept so
  // invalidation can flush entries orphaned by the v1 key change rather than
  // waiting for their TTL to lapse.
  legacyScoreResponse: (userId: string) => `score:userId:${userId}`,
  legacyScoreBreakdown: (publicKey: string) => `score:breakdown:${publicKey}`,

  // Idempotency / unsigned-tx keys – loan
  pendingLoanTx: (borrower: string, amount: number) => `pending_loan_tx:${borrower}:${amount}`,

  pendingRepayTx: (borrower: string, loanId: number, amount: number) =>
    `pending_repay_tx:${borrower}:${loanId}:${amount}`,

  // Idempotency / unsigned-tx keys – pool
  pendingDepositTx: (depositor: string, token: string, amount: number) =>
    `pending_deposit_tx:${depositor}:${token}:${amount}`,

  pendingWithdrawTx: (depositor: string, token: string, amount: number) =>
    `pending_withdraw_tx:${depositor}:${token}:${amount}`,
} as const;

/**
 * Invalidate every cached score read for a user after their score changes.
 * Covers the current versioned keys and the legacy unversioned keys so the
 * first deploy after the version bump flushes orphaned entries instead of
 * serving them until they expire.
 *
 * Call this after the DB write that changes a score commits.
 */
export async function invalidateOnScoreUpdate(userId: string): Promise<void> {
  await Promise.all([
    cacheService.delete(CacheKeys.scoreResponse(userId)),
    cacheService.delete(CacheKeys.scoreBreakdown(userId)),
    cacheService.delete(CacheKeys.legacyScoreResponse(userId)),
    cacheService.delete(CacheKeys.legacyScoreBreakdown(userId)),
  ]);
}

/**
 * Invalidate all cache keys that become stale after a repayment.
 * Call this after the DB transaction commits inside repayLoan.
 */
export async function invalidateOnRepay(borrower: string, _loanId: number): Promise<void> {
  await Promise.all([
    cacheService.delete(CacheKeys.poolStats()),
    cacheService.delete(CacheKeys.borrowerLoans(borrower)),
    cacheService.delete(CacheKeys.scoreBreakdown(borrower)),
  ]);
}

/**
 * Invalidate all cache keys that become stale after a new loan request.
 * Call this after the DB transaction commits inside requestLoan.
 */
export async function invalidateOnLoanRequest(borrower: string): Promise<void> {
  await Promise.all([
    cacheService.delete(CacheKeys.poolStats()),
    cacheService.delete(CacheKeys.borrowerLoans(borrower)),
  ]);
}

/**
 * Invalidate all cache keys that become stale after a pool deposit.
 * Call this after the DB transaction commits inside depositToPool.
 */
export async function invalidateOnDeposit(_depositor: string): Promise<void> {
  await cacheService.delete(CacheKeys.poolStats());
}

/**
 * Invalidate all cache keys that become stale after a pool withdrawal.
 * Call this after the DB transaction commits inside withdrawFromPool.
 */
export async function invalidateOnWithdraw(_depositor: string): Promise<void> {
  await cacheService.delete(CacheKeys.poolStats());
}
