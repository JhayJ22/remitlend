import { jest, describe, it, expect, beforeEach } from '@jest/globals';

/** In-memory cacheService so the SWR helper can be tested without Redis. */
const store = new Map<string, unknown>();
const lastTtl = new Map<string, number>();

const mockGet = jest.fn(async (key: string): Promise<unknown> => {
  return store.has(key) ? store.get(key) : null;
});
const mockSet = jest.fn(async (key: string, value: unknown, ttl?: number): Promise<void> => {
  store.set(key, value);
  if (typeof ttl === 'number') lastTtl.set(key, ttl);
});

jest.unstable_mockModule('../../services/cacheService.js', () => ({
  cacheService: {
    get: mockGet,
    set: mockSet,
    delete: jest.fn(async () => undefined),
    ping: jest.fn(async () => 'ok'),
    invalidatePattern: jest.fn(async () => undefined),
  },
}));

const {
  readSwr,
  writeSwr,
  dedupeByKey,
  refreshSwr,
  resetSwrInflight,
  swrInflightCount,
} = await import('../swrCache.js');

const VERSION = 1;
const OPTIONS = { freshTtl: 60, staleTtl: 300 };
const KEY = 'score:response:v1:alice';

beforeEach(() => {
  store.clear();
  lastTtl.clear();
  jest.clearAllMocks();
  resetSwrInflight();
});

describe('swrCache', () => {
  it('reads a missing key as a miss', async () => {
    const result = await readSwr(KEY, VERSION);
    expect(result).toEqual({ state: 'miss', value: null, ageMs: 0 });
  });

  it('writes an envelope covering the fresh and stale windows', async () => {
    const now = 1_000_000;
    await writeSwr(KEY, { score: 640 }, VERSION, OPTIONS, now);

    const envelope = store.get(KEY) as {
      v: number;
      value: unknown;
      storedAt: number;
      freshUntil: number;
      staleUntil: number;
    };
    expect(envelope.v).toBe(VERSION);
    expect(envelope.value).toEqual({ score: 640 });
    expect(envelope.storedAt).toBe(now);
    expect(envelope.freshUntil).toBe(now + 60_000);
    expect(envelope.staleUntil).toBe(now + 360_000);
    // Redis TTL spans the entire fresh + stale window.
    expect(lastTtl.get(KEY)).toBe(360);
  });

  it('classifies an entry as fresh before freshUntil', async () => {
    const now = 1_000_000;
    await writeSwr(KEY, { score: 640 }, VERSION, OPTIONS, now);

    const result = await readSwr(KEY, VERSION, now + 30_000);
    expect(result.state).toBe('fresh');
    expect(result.value).toEqual({ score: 640 });
    expect(result.ageMs).toBe(30_000);
  });

  it('classifies an entry as stale between freshUntil and staleUntil', async () => {
    const now = 1_000_000;
    await writeSwr(KEY, { score: 640 }, VERSION, OPTIONS, now);

    const result = await readSwr(KEY, VERSION, now + 120_000);
    expect(result.state).toBe('stale');
    expect(result.value).toEqual({ score: 640 });
  });

  it('classifies an entry past staleUntil as a miss', async () => {
    const now = 1_000_000;
    await writeSwr(KEY, { score: 640 }, VERSION, OPTIONS, now);

    const result = await readSwr(KEY, VERSION, now + 400_000);
    expect(result.state).toBe('miss');
    expect(result.value).toBeNull();
  });

  it('treats a malformed envelope as a miss', async () => {
    store.set(KEY, { not: 'an envelope' });
    const result = await readSwr(KEY, VERSION);
    expect(result.state).toBe('miss');
  });

  it('treats a schema-version mismatch as a miss', async () => {
    await writeSwr(KEY, { score: 640 }, VERSION, OPTIONS);
    const result = await readSwr(KEY, VERSION + 1);
    expect(result.state).toBe('miss');
  });

  it('deduplicates concurrent work for the same key', async () => {
    let resolveTask: (value: string) => void = () => undefined;
    const task = jest.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveTask = resolve;
        }),
    );

    const first = dedupeByKey(KEY, task);
    const second = dedupeByKey(KEY, task);

    expect(task).toHaveBeenCalledTimes(1);
    expect(swrInflightCount()).toBe(1);

    resolveTask('done');
    await expect(first).resolves.toBe('done');
    await expect(second).resolves.toBe('done');
    expect(swrInflightCount()).toBe(0);
  });

  it('refreshes a key on success', async () => {
    await refreshSwr(KEY, async () => ({ score: 700 }), VERSION, OPTIONS);

    const result = await readSwr(KEY, VERSION);
    expect(result.state).toBe('fresh');
    expect(result.value).toEqual({ score: 700 });
  });

  it('swallows refresh errors and leaves the previous entry intact', async () => {
    await writeSwr(KEY, { score: 500 }, VERSION, OPTIONS);

    await expect(
      refreshSwr(
        KEY,
        async () => {
          throw new Error('origin unavailable');
        },
        VERSION,
        OPTIONS,
      ),
    ).resolves.toBeUndefined();

    expect(swrInflightCount()).toBe(0);
    const result = await readSwr(KEY, VERSION);
    expect(result.state).toBe('fresh');
    expect(result.value).toEqual({ score: 500 });
  });
});
