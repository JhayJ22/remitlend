/**
 * Access control for the network telemetry admin surface (#857).
 *
 * The per-network telemetry + failover endpoints are operator-only and gated
 * by `requireApiKey('admin:indexer')`. These cases assert the access-control
 * boundary: a missing or invalid key is rejected (401), a key with the wrong
 * scope is rejected (403), and only a key carrying the required scope reaches
 * the controller (200). A minimal Express app mounts just the telemetry route
 * so the assertion is about authorization, not the full route tree.
 */

import { jest, describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import express, { Router } from 'express';
import request from 'supertest';

jest.unstable_mockModule('../db/connection.js', () => ({
  default: { query: jest.fn(async () => ({ rows: [] })) },
  query: jest.fn(async () => ({ rows: [] })),
  getClient: jest.fn(),
  withTransaction: jest.fn(),
}));

const { requireApiKey } = await import('../middleware/auth.js');
const { getNetworkTelemetry } = await import('../controllers/networkTelemetryController.js');
const { sorobanWriteQueue, InMemorySorobanWriteQueueStore } = await import(
  '../services/sorobanWriteQueue.js'
);

const VALID_KEY = 'validkey1234567890';
const WRONG_SCOPE_KEY = 'wrongscopekey0000';

function buildApp() {
  const app = express();
  app.use(express.json());
  const router = Router();
  router.get('/network-telemetry', requireApiKey('admin:indexer'), getNetworkTelemetry);
  app.use('/api/admin', router);
  // Minimal error handler: converts AppError to its HTTP status without
  // pulling in the global handler's Sentry wiring.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: { statusCode?: number; errorCode?: string; message?: string }, _req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }, _next: unknown) => {
    const status = err.statusCode ?? 500;
    res.status(status).json({
      success: false,
      error: { code: err.errorCode ?? 'INTERNAL_ERROR', message: err.message ?? 'error' },
    });
  });
  return app;
}

describe('Network telemetry access control (#857)', () => {
  beforeEach(() => {
    sorobanWriteQueue.setStore(new InMemorySorobanWriteQueueStore());
    // A scoped admin:indexer key plus a key scoped to a different namespace.
    process.env.INTERNAL_API_KEY = `admin:indexer:${VALID_KEY},admin:webhooks:${WRONG_SCOPE_KEY}`;
    process.env.STELLAR_NETWORK = 'testnet';
  });

  afterAll(() => {
    delete process.env.INTERNAL_API_KEY;
  });

  it('rejects a request with no API key (401)', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/admin/network-telemetry');
    expect(res.status).toBe(401);
  });

  it('rejects a request with an invalid API key (401)', async () => {
    const app = buildApp();
    const res = await request(app)
      .get('/api/admin/network-telemetry')
      .set('x-api-key', 'definitely-not-a-real-key-9');
    expect(res.status).toBe(401);
  });

  it('rejects a key that lacks the required scope (403)', async () => {
    const app = buildApp();
    const res = await request(app)
      .get('/api/admin/network-telemetry')
      .set('x-api-key', WRONG_SCOPE_KEY);
    expect(res.status).toBe(403);
  });

  it('allows a request with a correctly scoped key (200) and returns telemetry', async () => {
    const app = buildApp();
    const res = await request(app)
      .get('/api/admin/network-telemetry')
      .set('x-api-key', VALID_KEY);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.telemetry).toBeDefined();
    expect(res.body.data.failover).toBeDefined();
    expect(res.body.data.failover.activeEndpointId).toBe('testnet');
  });
});
