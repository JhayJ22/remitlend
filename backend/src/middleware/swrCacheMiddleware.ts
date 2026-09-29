import type { NextFunction, Request, Response } from 'express';
import { SCORE_CACHE_VERSION } from '../utils/cacheKeys.js';
import {
  dedupeByKey,
  readSwr,
  refreshSwr,
  writeSwr,
  type SwrOptions,
} from '../utils/swrCache.js';

/** Fresh window for score reads — short enough that updates surface quickly. */
export const SCORE_CACHE_FRESH_TTL_SECONDS = 60;
/** Stale window served while a background refresh is in flight. */
export const SCORE_CACHE_STALE_TTL_SECONDS = 300;

export type CacheKeyBuilder = (req: Request) => string | null | undefined;
export type ResponseComputer<T> = (req: Request) => Promise<T>;

export interface SwrCacheMiddlewareOptions<T> {
  /** Builds the cache key for a request. Must encode the subject id + version. */
  key: CacheKeyBuilder;
  /** Produces the fresh response body on a miss or background refresh. */
  compute: ResponseComputer<T>;
  /** Payload schema version stored in the envelope. Defaults to SCORE_CACHE_VERSION. */
  version?: number;
  /** Overrides the default fresh window (seconds). */
  freshTtl?: number;
  /** Overrides the default stale window (seconds). */
  staleTtl?: number;
}

/**
 * Express middleware implementing stale-while-revalidate over the shared
 * `cacheService` (Redis). Mount it as the terminal handler of a read route:
 *
 *   - fresh entry → respond from cache (`X-Cache: HIT`)
 *   - stale entry → respond from cache immediately (`X-Cache: STALE`) and
 *                   refresh in the background (deduped, never awaited)
 *   - no entry    → compute, persist with fresh + stale TTLs (`X-Cache: MISS`)
 *
 * Revalidation failures never fail the served request and a Redis outage
 * degrades to an uncached passthrough because `cacheService` is fail-safe.
 */
export function createSwrCacheMiddleware<T>(options: SwrCacheMiddlewareOptions<T>) {
  const version = options.version ?? SCORE_CACHE_VERSION;
  const swrOptions: SwrOptions = {
    freshTtl: options.freshTtl ?? SCORE_CACHE_FRESH_TTL_SECONDS,
    staleTtl: options.staleTtl ?? SCORE_CACHE_STALE_TTL_SECONDS,
  };

  return async function swrCacheMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const key = options.key(req);
    if (!key) {
      next();
      return;
    }

    try {
      const cached = await readSwr<T>(key, version);

      if (cached.state === 'fresh') {
        res.setHeader('X-Cache', 'HIT');
        res.setHeader('X-Cache-Age', String(Math.floor(cached.ageMs / 1000)));
        res.json(cached.value);
        return;
      }

      if (cached.state === 'stale') {
        res.setHeader('X-Cache', 'STALE');
        res.setHeader('X-Cache-Age', String(Math.floor(cached.ageMs / 1000)));
        res.json(cached.value);
        // Fire-and-forget: refresh the entry for the next request without
        // blocking this one. Deduped per key inside refreshSwr.
        void refreshSwr(key, () => options.compute(req), version, swrOptions);
        return;
      }

      const value = await dedupeByKey(key, async () => {
        const computed = await options.compute(req);
        await writeSwr(key, computed, version, swrOptions);
        return computed;
      });

      res.setHeader('X-Cache', 'MISS');
      res.json(value);
    } catch (error) {
      next(error);
    }
  };
}
