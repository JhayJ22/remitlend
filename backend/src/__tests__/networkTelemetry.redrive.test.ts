/**
 * Dead-letter re-drive guardrails for the network telemetry admin surface (#857).
 *
 * A stale or invalid re-drive must be rejected without mutation, and listing
 * dead letters must expose metadata only (never the signed XDR payload).
 */

import { jest, describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import express, { Router } from 'express';
import request from 'supertest';

const mockQuery = jest.fn(async () => ({ rows: [] as Record<string, unknown>[] }));

jest.unstable_mockModule('../db/connection.js', () => ({
  default: { query: mockQuery },
  query: mockQuery,
  getClient: jest.fn(),
  withTransaction: jest.fn(),
}));

const { requireApiKey } = await import('../middleware/auth.js');
const {
  listDeadLetterWrites,
  redriveDeadLetterWrite,
} = await import('../controllers/networkTelemetryController.js');
const { sorobanWriteQueue, InMemorySorobanWriteQueueStore } = await import(
  '../services/sorobanWriteQueue.js'
);

const VALID_KEY = 'validkey1234567890';

function buildApp() {
  const app = express();
  app.use(express.json());
  const router = Router();
  router.get('/network-failover/dead-letters', requireApiKey('admin:indexer'), listDeadLetterWrites);
  router.post(
    '/network-failover/dead-letters/:id/redrive',
    requireApiKey('admin:indexer'),
    redriveDeadLetterWrite,
  );
  app.use('/api/admin', router);
  app.use((err: { statusCode?: number; errorCode?: string; message?: string }, _req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }, _next: unknown) => {
    res.status(err.statusCode ?? 500).json({
      success: false,
      error: { code: err.errorCode ?? 'INTERNAL_ERROR', message: err.message ?? 'error' },
    });
  });
  return app;
}

describe('Network dead-letter admin guards (#857)', () => {
  beforeEach(() => {
    sorobanWriteQueue.setStore(new InMemorySorobanWriteQueueStore());
    process.env.INTERNAL_API_KEY = `admin:indexer:${VALID_KEY}`;
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [] } as never);
  });

  afterAll(() => {
    delete process.env.INTERNAL_API_KEY;
  });

  it('rejects a non-positive id before querying or mutating', async () => {
    const res = await request(buildApp())
      .post('/api/admin/network-failover/dead-letters/not-an-id/redrive')
      .set('x-api-key', VALID_KEY);

    expect(res.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('rejects a stale (no longer dead-lettered) id without requeueing', async () => {
    const res = await request(buildApp())
      .post('/api/admin/network-failover/dead-letters/42/redrive')
      .set('x-api-key', VALID_KEY);

    expect(res.status).toBe(404);
    expect(await sorobanWriteQueue.pendingCount()).toBe(0);
    expect(await sorobanWriteQueue.deadLetterCount()).toBe(0);
  });

  it('redrives a dead-lettered write with its signed payload unchanged', async () => {
    const signedXdr = 'unchanged-signed-xdr';
    const queued = await sorobanWriteQueue.enqueue({
      idempotencyKey: 'submit:redrive-test',
      operation: 'submit_signed_tx',
      payload: { signedTxXdr: signedXdr },
    });
    await sorobanWriteQueue.markDeadLetter(queued.record.id, 'bounded retry ceiling');
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: queued.record.id, attempts: 10, max_attempts: 10 }],
    } as never);

    const res = await request(buildApp())
      .post(`/api/admin/network-failover/dead-letters/${queued.record.id}/redrive`)
      .set('x-api-key', VALID_KEY);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: queued.record.id, status: 'pending' });
    expect(await sorobanWriteQueue.pendingCount()).toBe(1);
    expect(await sorobanWriteQueue.deadLetterCount()).toBe(0);
    const pending = await sorobanWriteQueue.listReadyForReplay(10);
    expect(pending[0]?.payload.signedTxXdr).toBe(signedXdr);
  });

  it('lists dead-letter metadata without signed XDR payloads', async () => {
    const queued = await sorobanWriteQueue.enqueue({
      idempotencyKey: 'submit:list-test',
      operation: 'submit_signed_tx',
      payload: { signedTxXdr: 'secret-signed-xdr' },
    });
    await sorobanWriteQueue.markDeadLetter(queued.record.id, 'bounded retry ceiling');

    const res = await request(buildApp())
      .get('/api/admin/network-failover/dead-letters')
      .set('x-api-key', VALID_KEY);

    expect(res.status).toBe(200);
    expect(res.body.data.deadLetters).toHaveLength(1);
    expect(res.body.data.deadLetters[0]).toMatchObject({
      id: queued.record.id,
      operation: 'submit_signed_tx',
      attempts: 0,
    });
    expect(JSON.stringify(res.body)).not.toContain('secret-signed-xdr');
  });
});
