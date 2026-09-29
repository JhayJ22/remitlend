import { cacheService } from '../services/cacheService.js';

/**
 * Stale-while-revalidate (SWR) cache helper.
 *
 * Entries are stored as a self-describing envelope under a single Redis key.
 * Two deadlines live inside the envelope instead of relying on the Redis TTL
 * alone:
 *
 *   storedAt ──freshUntil──────────staleUntil──────►
 *      fresh window          stale window
 *      (serve as-is)         (serve immediately, refresh in background)
 *
 * The Redis TTL is set to the whole fresh + stale window so the entry remains
 * readable while stale. Once Redis evicts the key (or `staleUntil` passes) a
 * read is reported as a miss.
 */

export interface SwrOptions {
  /** Seconds an entry is served without a background refresh. */
  freshTtl: number;
  /** Extra seconds the entry may be served stale while revalidating. */
  staleTtl: number;
}

export interface SwrEnvelope<T> {
  /** Payload schema version. A mismatch is treated as a cache miss. */
  v: number;
  value: T;
  /** Epoch ms the entry was written. */
  storedAt: number;
  /** Epoch ms after which the entry becomes stale. */
  freshUntil: number;
  /** Epoch ms after which the entry must not be served at all. */
  staleUntil: number;
}

export type SwrState = 'miss' | 'fresh' | 'stale';

export interface SwrReadResult<T> {
  state: SwrState;
  value: T | null;
  /** Milliseconds since the entry was written (0 on a miss). */
  ageMs: number;
}

/**
 * In-process registry of cache keys with an in-flight compute/refresh.
 * Keying on the cache key deduplicates both concurrent cache misses and
 * concurrent background revalidations so a popular key is only recomputed
 * once at a time.
 */
const inflight = new Map<string, Promise<unknown>>();

/** Number of keys currently being computed/refreshed (tests + diagnostics). */
export const swrInflightCount = (): number => inflight.size;

/** Clear the in-flight registry (tests only). */
export const resetSwrInflight = (): void => {
  inflight.clear();
};

const isEnvelope = <T>(candidate: unknown): candidate is SwrEnvelope<T> => {
  if (!candidate || typeof candidate !== 'object') return false;
  const entry = candidate as Record<string, unknown>;
  return (
    typeof entry.v === 'number' &&
    typeof entry.storedAt === 'number' &&
    typeof entry.freshUntil === 'number' &&
    typeof entry.staleUntil === 'number' &&
    'value' in entry
  );
};

/**
 * Read an SWR entry, classifying it as `fresh`, `stale`, or `miss`.
 * A malformed envelope or a schema-version mismatch is reported as a miss so a
 * cached payload can never leak across incompatible response shapes.
 */
export async function readSwr<T>(
  key: string,
  version: number,
  now: number = Date.now(),
): Promise<SwrReadResult<T>> {
  const stored = await cacheService.get<SwrEnvelope<T>>(key);
  if (!isEnvelope<T>(stored) || stored.v !== version) {
    return { state: 'miss', value: null, ageMs: 0 };
  }
  const ageMs = Math.max(0, now - stored.storedAt);
  if (now < stored.freshUntil) {
    return { state: 'fresh', value: stored.value, ageMs };
  }
  if (now < stored.staleUntil) {
    return { state: 'stale', value: stored.value, ageMs };
  }
  return { state: 'miss', value: null, ageMs: 0 };
}

/**
 * Persist `value` wrapped in an SWR envelope. The Redis TTL spans the fresh and
 * stale windows so the stale copy remains readable until it expires.
 */
export async function writeSwr<T>(
  key: string,
  value: T,
  version: number,
  options: SwrOptions,
  now: number = Date.now(),
): Promise<void> {
  const freshUntil = now + options.freshTtl * 1000;
  const staleUntil = freshUntil + options.staleTtl * 1000;
  const envelope: SwrEnvelope<T> = { v: version, value, storedAt: now, freshUntil, staleUntil };
  await cacheService.set(key, envelope, Math.ceil((staleUntil - now) / 1000));
}

/**
 * Run `task` at most once at a time per `key`. Concurrent callers for the same
 * key share the in-flight promise instead of stampeding the origin.
 */
export function dedupeByKey<T>(key: string, task: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;

  const promise = (async () => {
    try {
      return await task();
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  return promise;
}

/**
 * Refresh a key in the background: recompute, persist, and swallow all errors.
 * Never awaited by a request handler — a failed refresh simply leaves the
 * existing stale entry in place until its stale window elapses.
 */
export function refreshSwr<T>(
  key: string,
  compute: () => Promise<T>,
  version: number,
  options: SwrOptions,
): Promise<void> {
  return dedupeByKey(key, async () => {
    const value = await compute();
    await writeSwr(key, value, version, options);
  }).then(
    () => undefined,
    () => undefined,
  );
}
