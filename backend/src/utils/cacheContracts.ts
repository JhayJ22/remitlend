import { cacheService } from '../services/cacheService.js';
import {
  cacheInvalidationCounter,
  cacheInvalidationFailureCounter,
  cacheStaleReadCounter,
} from '../middleware/metrics.js';
import { CacheKeys, invalidateOnScoreUpdate } from './cacheKeys.js';
import logger from './logger.js';

/**
 * Freshness contracts for cache-backed financial reads (#513).
 *
 * Money calculations NEVER read from these caches: they use the database /
 * chain directly. The caches only back display projections. On any Redis
 * failure reads fall through to the authoritative loader.
 *
 * Invalidation is exact-key DELETE (no SCAN/KEYS). DELETE is idempotent and
 * commutative, so duplicate and out-of-order events are safe. The one hazard
 * is a reader that loaded pre-event data re-filling the cache after the
 * delete; `readThrough` guards that with a per-resource generation counter.
 */
export type CacheResource =
  | 'pool_stats'
  | 'borrower_loans'
  | 'score_response'
  | 'score_breakdown'
  | 'pool_share_price'
  | 'user_profile'
  | 'score_history_onchain'
  | 'score_nft';

export interface CacheContract {
  sourceOfTruth: string;
  /** Upper bound on staleness if invalidation is lost (the key TTL). */
  maxStalenessSeconds: number;
  invalidationTrigger: string;
}

export const CACHE_CONTRACTS: Readonly<Record<CacheResource, CacheContract>> = {
  pool_stats: {
    sourceOfTruth: 'Postgres (indexed Deposit/Withdraw/Loan* events)',
    maxStalenessSeconds: 300,
    invalidationTrigger:
      'Indexer commit of Deposit/Withdraw/EmergencyWithdraw/LoanApproved/LoanRepaid/LoanDefaulted; API deposit/withdraw/repay/request',
  },
  borrower_loans: {
    sourceOfTruth: 'Postgres loan_events/loans (indexed from chain)',
    maxStalenessSeconds: 300,
    invalidationTrigger:
      'Indexer commit of Loan* events for the borrower address; API repay/request',
  },
  score_response: {
    sourceOfTruth: 'Postgres scores (updated from LoanRepaid/LoanDefaulted)',
    maxStalenessSeconds: 300,
    invalidationTrigger: 'invalidateOnScoreUpdate after score write; indexer Loan* events',
  },
  score_breakdown: {
    sourceOfTruth: 'Postgres scores + loan history',
    maxStalenessSeconds: 300,
    invalidationTrigger: 'invalidateOnScoreUpdate after score write; indexer Loan* events',
  },
  pool_share_price: {
    sourceOfTruth: 'Soroban pool contract get_share_price (chain)',
    maxStalenessSeconds: 30,
    invalidationTrigger:
      'API deposit/withdraw/emergency-withdraw/repay/pool submit/liquidate (pattern pool:share-price:*); 30s TTL bound',
  },
  user_profile: {
    sourceOfTruth: 'Postgres user_profiles',
    maxStalenessSeconds: 120,
    invalidationTrigger: 'invalidateOnProfileUpdate after PATCH /user/profile commits',
  },
  score_history_onchain: {
    sourceOfTruth: 'Soroban RemittanceNFT contract score history (chain)',
    maxStalenessSeconds: 60,
    invalidationTrigger: 'TTL expiry only (60s bound); written by chain, not by any API write',
  },
  score_nft: {
    sourceOfTruth: 'Soroban RemittanceNFT contract metadata (chain)',
    maxStalenessSeconds: 60,
    invalidationTrigger: 'TTL expiry only (60s bound); written by chain, not by any API write',
  },
};

/**
 * Write → invalidation mapping (#794). Every API write endpoint that changes
 * data served by a cached GET is listed with the resources it busts and the
 * GET endpoints that read them. `cacheInvalidation.test.ts` asserts each pair:
 * the helper named in `invalidator` deletes the keys the GETs read.
 */
export interface WriteInvalidation {
  /** HTTP method + path of the write endpoint. */
  write: string;
  /** Exported helper in cacheKeys.ts the handler calls after success. */
  invalidator: string;
  resources: CacheResource[];
  /** Cached GET endpoints whose data the write changes. */
  reads: string[];
}

export const WRITE_INVALIDATIONS: ReadonlyArray<WriteInvalidation> = [
  {
    write: 'POST /loans/request',
    invalidator: 'invalidateOnLoanRequest',
    resources: ['pool_stats', 'borrower_loans'],
    reads: ['GET /pool/stats', 'GET /loans/borrower/:borrower'],
  },
  {
    write: 'POST /loans/:loanId/repay',
    invalidator: 'invalidateOnRepay',
    resources: ['pool_stats', 'borrower_loans', 'score_breakdown', 'pool_share_price'],
    reads: [
      'GET /pool/stats',
      'GET /loans/borrower/:borrower',
      'GET /score/:userId/breakdown',
      'GET /pool/:token/share-price',
    ],
  },
  {
    write: 'POST /loans/:loanId/submit',
    invalidator: 'invalidateOnRepay',
    resources: ['pool_stats', 'borrower_loans', 'score_breakdown', 'pool_share_price'],
    reads: [
      'GET /pool/stats',
      'GET /loans/borrower/:borrower',
      'GET /score/:userId/breakdown',
      'GET /pool/:token/share-price',
    ],
  },
  ...[
    'POST /loans/:loanId/build-deposit-collateral',
    'POST /loans/:loanId/build-release-collateral',
    'POST /loans/:loanId/build-refinance',
    'POST /loans/:loanId/build-extend',
    'POST /loans/:loanId/build-cancel',
  ].map((write) => ({
    write,
    invalidator: 'invalidateOnLoanMutation',
    resources: ['pool_stats', 'borrower_loans'] as CacheResource[],
    reads: ['GET /pool/stats', 'GET /loans/borrower/:borrower'],
  })),
  {
    write: 'POST /loans/:loanId/liquidate/build',
    invalidator: 'invalidateOnUnscopedLoanWrite',
    resources: ['pool_stats', 'borrower_loans', 'pool_share_price'],
    reads: ['GET /pool/stats', 'GET /loans/borrower/:borrower', 'GET /pool/:token/share-price'],
  },
  ...['POST /pool/build-deposit', 'POST /pool/submit'].map((write) => ({
    write,
    invalidator: 'invalidateOnDeposit',
    resources: ['pool_stats', 'pool_share_price'] as CacheResource[],
    reads: ['GET /pool/stats', 'GET /pool/:token/share-price'],
  })),
  ...['POST /pool/build-withdraw', 'POST /pool/build-emergency-withdraw'].map((write) => ({
    write,
    invalidator: 'invalidateOnWithdraw',
    resources: ['pool_stats', 'pool_share_price'] as CacheResource[],
    reads: ['GET /pool/stats', 'GET /pool/:token/share-price'],
  })),
  {
    write: 'POST /score/update',
    invalidator: 'invalidateOnScoreUpdate',
    resources: ['score_response', 'score_breakdown'],
    reads: ['GET /score/:userId', 'GET /score/:userId/breakdown'],
  },
  {
    write: 'PATCH /user/profile',
    invalidator: 'invalidateOnProfileUpdate',
    resources: ['user_profile'],
    reads: ['GET /user/profile'],
  },
];

const generations: Record<CacheResource, number> = {
  pool_stats: 0,
  borrower_loans: 0,
  score_response: 0,
  score_breakdown: 0,
  pool_share_price: 0,
  user_profile: 0,
  score_history_onchain: 0,
  score_nft: 0,
};

/** Delete exact keys; meter attempts and unconfirmed deletes. Never throws. */
export async function invalidateKeys(resource: CacheResource, keys: string[]): Promise<boolean> {
  generations[resource] += 1;
  cacheInvalidationCounter.inc({ resource });
  try {
    const results = await Promise.all(keys.map((k) => cacheService.delete(k)));
    const ok = results.every((r) => r !== false);
    if (!ok) cacheInvalidationFailureCounter.inc({ resource });
    return ok;
  } catch (error) {
    cacheInvalidationFailureCounter.inc({ resource });
    logger.withContext().error('Cache invalidation failed', { resource, error });
    return false;
  }
}

const POOL_EVENTS = new Set([
  'Deposit',
  'Withdraw',
  'EmergencyWithdraw',
  'LoanApproved',
  'LoanRepaid',
  'LoanDefaulted',
  'CollateralLiquidated',
  'LoanLiquidated',
]);
const LOAN_EVENTS = new Set([
  'LoanApproved',
  'LoanRepaid',
  'LoanDefaulted',
  'CollateralLiquidated',
  'LoanLiquidated',
]);

/**
 * Invalidate projections affected by committed chain events. Safe to call
 * with duplicates / any ordering; touches only keys derived from the events.
 */
export async function invalidateForChainEvents(
  events: ReadonlyArray<{ eventType: string; address?: string | null }>,
): Promise<void> {
  try {
    let pool = false;
    const borrowers = new Set<string>();
    for (const e of events) {
      if (POOL_EVENTS.has(e.eventType)) pool = true;
      if (LOAN_EVENTS.has(e.eventType) && e.address) borrowers.add(e.address);
    }
    if (pool) await invalidateKeys('pool_stats', [CacheKeys.poolStats()]);
    for (const b of borrowers) {
      await invalidateKeys('borrower_loans', [CacheKeys.borrowerLoans(b)]);
      await invalidateOnScoreUpdate(b);
      generations.score_response += 1;
      generations.score_breakdown += 1;
    }
  } catch (error) {
    cacheInvalidationFailureCounter.inc({ resource: 'pool_stats' });
    logger.withContext().error('Event cache invalidation failed', { error });
  }
}

/**
 * Cache-aside read with Redis-failure fallback and refill-race protection.
 * If an invalidation for the resource ran while `load` was in flight, the
 * (possibly pre-event) result is returned but NOT cached.
 */
export async function readThrough<T>(
  resource: CacheResource,
  key: string,
  ttlSeconds: number,
  load: () => Promise<T>,
): Promise<T> {
  const ttl = Math.min(ttlSeconds, CACHE_CONTRACTS[resource].maxStalenessSeconds);
  let cached: T | null = null;
  try {
    cached = await cacheService.get<T>(key);
  } catch {
    cacheStaleReadCounter.inc({ resource, outcome: 'backend_error' });
  }
  if (cached !== null) {
    cacheStaleReadCounter.inc({ resource, outcome: 'fresh' });
    return cached;
  }
  cacheStaleReadCounter.inc({ resource, outcome: 'miss' });
  const genBefore = generations[resource];
  const value = await load();
  if (generations[resource] !== genBefore) {
    cacheStaleReadCounter.inc({ resource, outcome: 'race_skipped' });
    return value;
  }
  try {
    await cacheService.set(key, value, ttl);
  } catch {
    cacheStaleReadCounter.inc({ resource, outcome: 'backend_error' });
  }
  return value;
}
