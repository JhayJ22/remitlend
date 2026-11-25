import express from 'express';
import request from 'supertest';
import { describe, it, expect, jest } from '@jest/globals';

jest.unstable_mockModule('../db/connection.js', () => ({
  default: { query: jest.fn(), on: jest.fn(), connect: jest.fn() },
  query: jest.fn(),
  pool: { on: jest.fn(), connect: jest.fn() },
}));

jest.unstable_mockModule('../services/cacheService.js', () => ({
  cacheService: { get: jest.fn(), set: jest.fn() },
}));

const { AbuseTelemetryService } = await import('../services/abuseTelemetryService.js');
const { abuseTelemetryGuard } = await import('../middleware/abuseTelemetry.js');

const FIXED_NOW = new Date('2026-06-15T12:34:56.000Z');

type TestCounter = { increment: (key: string, windowMs: number) => Promise<number> };
type TestQuery = () => Promise<{ rows: never[]; rowCount: number }>;

function makeService(
  counter?: TestCounter,
  queryFn: TestQuery = jest.fn(async () => ({ rows: [], rowCount: 1 })),
) {
  return new AbuseTelemetryService({
    counter: counter ?? { increment: jest.fn(async () => 1) },
    queryFn,
    now: () => FIXED_NOW,
    pepper: 'test-pepper',
  });
}

function makeApp(
  service: InstanceType<typeof AbuseTelemetryService>,
  onAction: () => void,
  withAuth = true,
) {
  const app = express();
  app.use(express.json());
  if (withAuth) {
    app.use((req, _res, next) => {
      req.user = { publicKey: 'GACTORPUBLICKEY' } as typeof req.user;
      next();
    });
  }
  app.post('/financial-action', abuseTelemetryGuard('loan_repay', { service }), (_req, res) => {
    onAction();
    res.json({ ok: true });
  });
  app.use(
    (
      err: Error & { statusCode?: number },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(err.statusCode ?? 500).json({ success: false, errorCode: err.message });
    },
  );
  return app;
}

describe('abuse telemetry guard — blocked requests create no financial state', () => {
  it('short-circuits before the handler when the risk window is exhausted', async () => {
    const telemetryQuery = jest.fn(async () => ({ rows: [], rowCount: 1 }));
    const financialMutation = jest.fn();
    const service = makeService({ increment: jest.fn(async () => 21) }, telemetryQuery);

    const response = await request(makeApp(service, financialMutation)).post('/financial-action');

    expect(response.status).toBe(429);
    expect(financialMutation).not.toHaveBeenCalled();
    expect(telemetryQuery).toHaveBeenCalledTimes(1);
    const [, values] = telemetryQuery.mock.calls[0] as [string, unknown[]];
    expect(values[3]).toBe('block');
    expect(values[4]).toBe('blocked');
  });

  it('allows requests below the threshold and records a success outcome', async () => {
    const telemetryQuery = jest.fn(async () => ({ rows: [], rowCount: 1 }));
    const financialMutation = jest.fn();
    const service = makeService(undefined, telemetryQuery);

    const response = await request(makeApp(service, financialMutation)).post('/financial-action');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(response.status).toBe(200);
    expect(financialMutation).toHaveBeenCalledTimes(1);
    expect(telemetryQuery).toHaveBeenCalledTimes(1);
    const [, values] = telemetryQuery.mock.calls[0] as [string, unknown[]];
    expect(values[4]).toBe('success');
  });

  it('records a failure outcome when the downstream handler responds with an error', async () => {
    const telemetryQuery = jest.fn(async () => ({ rows: [], rowCount: 1 }));
    const app = express();
    app.use((req, _res, next) => {
      req.user = { publicKey: 'GACTORPUBLICKEY' } as typeof req.user;
      next();
    });
    app.post(
      '/financial-action',
      abuseTelemetryGuard('loan_repay', { service: makeService(undefined, telemetryQuery) }),
      (_req, res) => {
        res.status(500).json({ ok: false });
      },
    );

    await request(app).post('/financial-action');
    await new Promise((resolve) => setTimeout(resolve, 0));

    const [, values] = telemetryQuery.mock.calls[0] as [string, unknown[]];
    expect(values[4]).toBe('failure');
  });

  it('fails open without blocking when the telemetry dependency is unavailable', async () => {
    const financialMutation = jest.fn();
    const service = makeService({
      increment: jest.fn(async () => {
        throw new Error('redis down');
      }),
    });

    const response = await request(makeApp(service, financialMutation)).post('/financial-action');

    expect(response.status).toBe(200);
    expect(financialMutation).toHaveBeenCalledTimes(1);
  });

  it('skips telemetry entirely for unauthenticated requests', async () => {
    const counter = { increment: jest.fn(async () => 1) };
    const telemetryQuery = jest.fn(async () => ({ rows: [], rowCount: 1 }));
    const service = makeService(counter, telemetryQuery);

    const response = await request(makeApp(service, jest.fn(), false)).post('/financial-action');

    expect(response.status).toBe(200);
    expect(counter.increment).not.toHaveBeenCalled();
    expect(telemetryQuery).not.toHaveBeenCalled();
  });

  it('does not count an idempotent replay as a fresh attempt', async () => {
    const counter = { increment: jest.fn(async () => 1) };
    const financialMutation = jest.fn();
    const service = makeService(counter);

    const response = await request(makeApp(service, financialMutation))
      .post('/financial-action')
      .set('X-Idempotent-Replayed', 'true');

    expect(response.status).toBe(200);
    expect(financialMutation).toHaveBeenCalledTimes(1);
    expect(counter.increment).not.toHaveBeenCalled();
  });
});
