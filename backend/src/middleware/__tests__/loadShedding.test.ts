/**
 * Tests for the load-shedding middleware — issue #809.
 *
 * Uses mocked metrics (getEventLoopLagMs / getHeapUsagePct) so the tests are
 * deterministic and do not depend on actual process load.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from '@jest/globals';
import express, { type Request, type Response } from 'express';
import request from 'supertest';

// ── We need to mock the internal helpers BEFORE importing the middleware ──────
// Jest ES-module mocking via vi.mock with a factory is not available in ts-jest
// without special config, so we use module-level spies instead.

import * as loadSheddingModule from '../loadShedding.js';

const getEventLoopLagMsSpy = vi
  .spyOn(loadSheddingModule, 'getEventLoopLagMs')
  .mockReturnValue(0);

const getHeapUsagePctSpy = vi
  .spyOn(loadSheddingModule, 'getHeapUsagePct')
  .mockReturnValue(0);

const { loadSheddingMiddleware, requestsShedTotal } = loadSheddingModule;

// ── Helper: build a minimal Express app with the middleware ───────────────────

function makeApp(opts: Parameters<typeof loadSheddingMiddleware>[0] = {}) {
  const app = express();
  app.use(loadSheddingMiddleware(opts));
  app.get('/api/test', (_req: Request, res: Response) => res.json({ ok: true }));
  app.get('/health', (_req: Request, res: Response) => res.json({ status: 'ok' }));
  app.get('/healthz/ready', (_req: Request, res: Response) => res.json({ status: 'ok' }));
  app.get('/metrics', (_req: Request, res: Response) => res.send('# metrics'));
  return app;
}

describe('loadSheddingMiddleware — issue #809', () => {
  beforeEach(() => {
    getEventLoopLagMsSpy.mockReturnValue(0);
    getHeapUsagePctSpy.mockReturnValue(0);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── Normal operation ────────────────────────────────────────────────────────

  it('passes requests through when both metrics are below thresholds', async () => {
    getEventLoopLagMsSpy.mockReturnValue(50);  // below 100 ms default
    getHeapUsagePctSpy.mockReturnValue(70);    // below 85 % default

    const app = makeApp();
    const res = await request(app).get('/api/test');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  // ── Event-loop lag shedding ─────────────────────────────────────────────────

  it('returns 503 when event-loop lag exceeds threshold', async () => {
    getEventLoopLagMsSpy.mockReturnValue(150); // above 100 ms default

    const app = makeApp();
    const res = await request(app).get('/api/test');
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('5');
    expect(res.body.error).toMatch(/event-loop lag/i);
  });

  it('increments requests_shed_total counter with reason=event_loop_lag', async () => {
    getEventLoopLagMsSpy.mockReturnValue(200);

    const before = (await requestsShedTotal.get()).values.find(
      (v) => v.labels.reason === 'event_loop_lag',
    )?.value ?? 0;

    const app = makeApp();
    await request(app).get('/api/test');

    const after = (await requestsShedTotal.get()).values.find(
      (v) => v.labels.reason === 'event_loop_lag',
    )?.value ?? 0;

    expect(after).toBeGreaterThan(before);
  });

  // ── Heap usage shedding ─────────────────────────────────────────────────────

  it('returns 503 when heap usage exceeds threshold', async () => {
    getHeapUsagePctSpy.mockReturnValue(90); // above 85 % default

    const app = makeApp();
    const res = await request(app).get('/api/test');
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('5');
    expect(res.body.error).toMatch(/memory pressure/i);
  });

  it('increments requests_shed_total counter with reason=heap_usage', async () => {
    getHeapUsagePctSpy.mockReturnValue(95);

    const before = (await requestsShedTotal.get()).values.find(
      (v) => v.labels.reason === 'heap_usage',
    )?.value ?? 0;

    const app = makeApp();
    await request(app).get('/api/test');

    const after = (await requestsShedTotal.get()).values.find(
      (v) => v.labels.reason === 'heap_usage',
    )?.value ?? 0;

    expect(after).toBeGreaterThan(before);
  });

  // ── Exempt endpoints ────────────────────────────────────────────────────────

  it('exempts /health from shedding even when thresholds are exceeded', async () => {
    getEventLoopLagMsSpy.mockReturnValue(500);
    getHeapUsagePctSpy.mockReturnValue(99);

    const app = makeApp();
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
  });

  it('exempts /healthz/* from shedding', async () => {
    getEventLoopLagMsSpy.mockReturnValue(500);

    const app = makeApp();
    const res = await request(app).get('/healthz/ready');
    expect(res.status).toBe(200);
  });

  it('exempts /metrics from shedding', async () => {
    getHeapUsagePctSpy.mockReturnValue(99);

    const app = makeApp();
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(200);
  });

  // ── Custom thresholds via options ───────────────────────────────────────────

  it('respects custom lagThresholdMs option', async () => {
    getEventLoopLagMsSpy.mockReturnValue(50); // below default 100 ms but above custom 20 ms

    const app = makeApp({ lagThresholdMs: 20 });
    const res = await request(app).get('/api/test');
    expect(res.status).toBe(503);
  });

  it('respects custom heapThresholdPct option', async () => {
    getHeapUsagePctSpy.mockReturnValue(60); // below default 85 % but above custom 50 %

    const app = makeApp({ heapThresholdPct: 50 });
    const res = await request(app).get('/api/test');
    expect(res.status).toBe(503);
  });

  it('respects custom retryAfterSecs option', async () => {
    getEventLoopLagMsSpy.mockReturnValue(200);

    const app = makeApp({ retryAfterSecs: 30 });
    const res = await request(app).get('/api/test');
    expect(res.headers['retry-after']).toBe('30');
    expect(res.body.retryAfter).toBe(30);
  });

  // ── Environment variable thresholds ────────────────────────────────────────

  it('reads LOAD_SHED_LAG_MS env variable', async () => {
    process.env.LOAD_SHED_LAG_MS = '10';
    getEventLoopLagMsSpy.mockReturnValue(15); // above env threshold

    // Create a fresh middleware instance so it reads the env var.
    const app = express();
    app.use(loadSheddingMiddleware());
    app.get('/api/test', (_req: Request, res: Response) => res.json({ ok: true }));

    const res = await request(app).get('/api/test');
    expect(res.status).toBe(503);

    delete process.env.LOAD_SHED_LAG_MS;
  });

  it('reads LOAD_SHED_HEAP_PCT env variable', async () => {
    process.env.LOAD_SHED_HEAP_PCT = '10';
    getHeapUsagePctSpy.mockReturnValue(15); // above env threshold

    const app = express();
    app.use(loadSheddingMiddleware());
    app.get('/api/test', (_req: Request, res: Response) => res.json({ ok: true }));

    const res = await request(app).get('/api/test');
    expect(res.status).toBe(503);

    delete process.env.LOAD_SHED_HEAP_PCT;
  });
});
