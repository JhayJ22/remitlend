import { generateKeyPairSync } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { jest } from '@jest/globals';
import { Keypair } from '@stellar/stellar-sdk';
import { generateJwtToken } from '../services/authService.js';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

process.env.JWT_SECRET = 'test-jwt-secret-min-32-chars-long!!';
process.env.STATEMENT_SIGNING_PRIVATE_KEY_PEM = privateKeyPem;
process.env.STATEMENT_SIGNING_KEY_ID = 'route-test-key';
process.env.STATEMENT_SUBJECT_PEPPER = 'route-test-pepper';

const mockQuery = jest.fn<(...args: unknown[]) => Promise<{ rows: unknown[] }>>();

jest.unstable_mockModule('../db/connection.js', () => ({
  default: { query: mockQuery },
  query: mockQuery,
  getClient: jest.fn(),
  closePool: jest.fn(),
  withTransaction: jest.fn(),
  PoolSaturatedError: class PoolSaturatedError extends Error {},
}));

jest.unstable_mockModule('../services/cacheService.js', () => ({
  cacheService: {
    get: jest.fn<() => Promise<null>>().mockResolvedValue(null),
    set: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    delete: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    ping: jest.fn<() => Promise<string>>().mockResolvedValue('ok'),
  },
}));

const { default: statementRoutes } = await import('../routes/statementRoutes.js');
const { errorHandler } = await import('../middleware/errorHandler.js');

const app = express();
app.use(express.json());
app.use('/api/v1/statements', statementRoutes);
app.use(errorHandler);

const WALLET = Keypair.random().publicKey();
const authHeader = `Bearer ${generateJwtToken(WALLET)}`;
const generatedAt = new Date().toISOString();

const validBody = {
  sourceType: 'activity',
  sourceCheckpoint: 'api:1:2026-06-15T12:00:00.000Z',
  statementDigest: 'b'.repeat(64),
  rowCount: 1,
  generatedAt,
};

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
});

describe('Statement manifest routes', () => {
  it('requires JWT authentication for signing', async () => {
    const response = await request(app).post('/api/v1/statements/manifests').send(validBody);
    expect(response.status).toBe(401);
  });

  it('signs a manifest without exposing private signing material', async () => {
    const response = await request(app)
      .post('/api/v1/statements/manifests')
      .set('Authorization', authHeader)
      .send(validBody);

    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);
    expect(response.body.data.signature).toEqual(expect.any(String));
    expect(response.body.data.verification.keyId).toBe('route-test-key');
    expect(JSON.stringify(response.body)).not.toContain(privateKeyPem);
    expect(JSON.stringify(response.body)).not.toContain(WALLET);
  });

  it('rejects stale statements without signing', async () => {
    const response = await request(app)
      .post('/api/v1/statements/manifests')
      .set('Authorization', authHeader)
      .send({ ...validBody, generatedAt: new Date(Date.now() - 20 * 60_000).toISOString() });

    expect(response.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('publishes the verification key publicly without private material', async () => {
    const response = await request(app).get('/api/v1/statements/verification-key');

    expect(response.status).toBe(200);
    expect(response.body.data.publicKeyPem).toContain('BEGIN PUBLIC KEY');
    expect(response.body.data.algorithm).toBe('Ed25519');
    expect(response.body.data.publicKeyPem).toBe(publicKeyPem);
    expect(JSON.stringify(response.body)).not.toContain('PRIVATE KEY');
  });

  it('returns 503 when the issuance registry is unavailable', async () => {
    mockQuery.mockRejectedValueOnce(new Error('db unavailable'));
    const response = await request(app)
      .post('/api/v1/statements/manifests')
      .set('Authorization', authHeader)
      .send(validBody);

    expect(response.status).toBe(503);
  });
});
