import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { NextFunction, Request, Response } from 'express';

/**
 * In-memory stand-in for the real Redis-backed cacheService. It lets the tests
 * exercise the SWR envelope logic (fresh/stale/miss, TTL, versioning) without a
 * Redis server, while keeping the same fail-safe async surface.
 */
const store = new Map<string, unknown>();

const mockGet = jest.fn(async (key: string): Promise<unknown> => {
  return store.has(key) ? store.get(key) : null;
});
const mockSet = jest.fn(async (key: string, value: unknown): Promise<void> => {
  store.set(key, value);
});
const mockDelete = jest.fn(async (key: string): Promise<void> => {
  store.delete(key);
});

jest.unstable_mockModule('../../services/cacheService.js', () => ({
  cacheService: {
    get: mockGet,
    set: mockSet,
    delete: mockDelete,
    ping: jest.fn(async () => 'ok'),
    invalidatePattern: jest.fn(async () => undefined),
  },
}));

const { createSwrCacheMiddleware } = await import('../swrCacheMiddleware.js');
const { writeSwr, resetSwrInflight, swrInflightCount } = await import('../../utils/swrCache.js');

const VERSION = 1;
const FRESH = 60;
const STALE = 300;
const KEY_ALICE = 'score:response:v1:alice';
const KEY_BOB = 'score:response:v1:bob';

type Middleware = (req: Request, res: Response, next: NextFunction) => Promise<void>;

interface CapturedResponse extends Response {
  body: unknown;
  headers: Record<string, string>;
}

const buildRequest = (userId: string): Request => ({ params: { userId } }) as unknown as Request;

const buildResponse = (): CapturedResponse => {
  const res = {
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      res.headers[name.toLowerCase()] = value;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
  };
  return res as unknown as CapturedResponse;
};

const runMiddleware = async (
  middleware: Middleware,
  req: Request,
  res: Response,
): Promise<void> => {
  await middleware(req, res, () => undefined);
};

const flush = async (): Promise<void> => {
  await new Promise<void>((resolve) => {
    setImmediate(() => resolve());
  });
  await new Promise<void>((resolve) => {
    setImmediate(() => resolve());
  });
};

const makeMiddleware = (compute: (req: Request) => Promise<unknown>): Middleware =>
  createSwrCacheMiddleware({
    key: (req) => {
      const userId = (req.params as { userId?: string }).userId;
      return `score:response:v${VERSION}:${userId}`;
    },
    compute,
    version: VERSION,
    freshTtl: FRESH,
    staleTtl: STALE,
  });

const seedStaleEntry = (key: string, value: unknown): void => {
  const now = Date.now();
  store.set(key, {
    v: VERSION,
    value,
    storedAt: now - (FRESH + 10) * 1000,
    freshUntil: now - 10 * 1000,
    staleUntil: now + 100 * 1000,
  });
};

beforeEach(() => {
  store.clear();
  jest.clearAllMocks();
  resetSwrInflight();
});

describe('createSwrCacheMiddleware', () => {
  it('serves a fresh entry without recomputing (HIT)', async () => {
    await writeSwr(KEY_ALICE, { userId: 'alice', score: 720 }, VERSION, {
      freshTtl: FRESH,
      staleTtl: STALE,
    });
    const compute = jest.fn(async () => ({ userId: 'alice', score: 999 }));

    const res = buildResponse();
    await runMiddleware(makeMiddleware(compute), buildRequest('alice'), res);

    expect(res.headers['x-cache']).toBe('HIT');
    expect(res.body).toEqual({ userId: 'alice', score: 720 });
    expect(compute).not.toHaveBeenCalled();
  });

  it('computes and stores a miss with a fresh + stale TTL (MISS)', async () => {
    const value = { userId: 'alice', score: 640 };
    const compute = jest.fn(async () => value);

    const res = buildResponse();
    await runMiddleware(makeMiddleware(compute), buildRequest('alice'), res);

    expect(res.headers['x-cache']).toBe('MISS');
    expect(res.body).toEqual(value);
    expect(compute).toHaveBeenCalledTimes(1);

    const envelope = store.get(KEY_ALICE) as {
      value: unknown;
      freshUntil: number;
      staleUntil: number;
    };
    expect(envelope.value).toEqual(value);
    expect(envelope.staleUntil - envelope.freshUntil).toBe(STALE * 1000);
    expect(mockSet).toHaveBeenCalledWith(KEY_ALICE, expect.anything(), FRESH + STALE);
  });

  it('serves a stale entry immediately and revalidates it in the background', async () => {
    const staleValue = { userId: 'alice', score: 500 };
    const freshValue = { userId: 'alice', score: 700 };
    seedStaleEntry(KEY_ALICE, staleValue);
    const compute = jest.fn(async () => freshValue);

    const first = buildResponse();
    await runMiddleware(makeMiddleware(compute), buildRequest('alice'), first);

    // The stale value is served on the first request without waiting on compute.
    expect(first.headers['x-cache']).toBe('STALE');
    expect(first.body).toEqual(staleValue);
    expect(compute).toHaveBeenCalledTimes(1);

    await flush();
    expect(swrInflightCount()).toBe(0);

    const second = buildResponse();
    await runMiddleware(makeMiddleware(compute), buildRequest('alice'), second);

    expect(second.headers['x-cache']).toBe('HIT');
    expect(second.body).toEqual(freshValue);
    // Background refresh already warmed the entry; no second recompute.
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('isolates cache entries per user', async () => {
    const compute = jest.fn(async (req: Request) => {
      const userId = (req.params as { userId: string }).userId;
      return { userId, score: userId === 'alice' ? 800 : 400 };
    });
    const middleware = makeMiddleware(compute);

    const aliceMiss = buildResponse();
    await runMiddleware(middleware, buildRequest('alice'), aliceMiss);
    const bobMiss = buildResponse();
    await runMiddleware(middleware, buildRequest('bob'), bobMiss);

    const aliceHit = buildResponse();
    await runMiddleware(middleware, buildRequest('alice'), aliceHit);
    const bobHit = buildResponse();
    await runMiddleware(middleware, buildRequest('bob'), bobHit);

    expect(aliceMiss.body).toEqual({ userId: 'alice', score: 800 });
    expect(bobMiss.body).toEqual({ userId: 'bob', score: 400 });
    expect(aliceHit.headers['x-cache']).toBe('HIT');
    expect(bobHit.headers['x-cache']).toBe('HIT');
    expect(aliceHit.body).toEqual({ userId: 'alice', score: 800 });
    expect(bobHit.body).toEqual({ userId: 'bob', score: 400 });
    expect(store.has(KEY_ALICE)).toBe(true);
    expect(store.has(KEY_BOB)).toBe(true);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('deduplicates concurrent background revalidations for the same key', async () => {
    seedStaleEntry(KEY_ALICE, { userId: 'alice', score: 500 });

    let resolveCompute: (value: { userId: string; score: number }) => void = () => undefined;
    const compute = jest.fn(
      () =>
        new Promise<{ userId: string; score: number }>((resolve) => {
          resolveCompute = resolve;
        }),
    );

    const middleware = makeMiddleware(compute);
    const first = buildResponse();
    const second = buildResponse();
    await runMiddleware(middleware, buildRequest('alice'), first);
    await runMiddleware(middleware, buildRequest('alice'), second);

    expect(first.headers['x-cache']).toBe('STALE');
    expect(second.headers['x-cache']).toBe('STALE');
    expect(compute).toHaveBeenCalledTimes(1);

    resolveCompute({ userId: 'alice', score: 650 });
    await flush();

    const third = buildResponse();
    await runMiddleware(makeMiddleware(compute), buildRequest('alice'), third);

    expect(third.headers['x-cache']).toBe('HIT');
    expect(third.body).toEqual({ userId: 'alice', score: 650 });
  });

  it('treats a payload-version mismatch as a miss', async () => {
    const now = Date.now();
    store.set(KEY_ALICE, {
      v: VERSION + 1,
      value: { userId: 'alice', score: 720 },
      storedAt: now,
      freshUntil: now + FRESH * 1000,
      staleUntil: now + (FRESH + STALE) * 1000,
    });
    const compute = jest.fn(async () => ({ userId: 'alice', score: 610 }));

    const res = buildResponse();
    await runMiddleware(makeMiddleware(compute), buildRequest('alice'), res);

    expect(res.headers['x-cache']).toBe('MISS');
    expect(res.body).toEqual({ userId: 'alice', score: 610 });
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('forwards compute errors to next() without caching anything', async () => {
    const failure = new Error('score lookup failed');
    const compute = jest.fn(async () => {
      throw failure;
    });
    const nextSpy = jest.fn();

    const res = buildResponse();
    await makeMiddleware(compute)(buildRequest('alice'), res, nextSpy as unknown as NextFunction);

    expect(nextSpy).toHaveBeenCalledWith(failure);
    expect(res.body).toBeUndefined();
    expect(store.has(KEY_ALICE)).toBe(false);
  });
});
