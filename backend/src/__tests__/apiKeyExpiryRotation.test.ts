import { describe, it, expect, jest, beforeEach } from '@jest/globals';

type Q = { rows: Record<string, any>[]; rowCount: number };
const mockQuery = jest.fn<(sql: string, params?: unknown[]) => Promise<Q>>();
const clientQuery = jest.fn<(sql: string, params?: unknown[]) => Promise<Q>>();
const mockCreateNotification = jest.fn<(p: unknown) => Promise<unknown>>().mockResolvedValue({});

jest.unstable_mockModule('../db/connection.js', () => ({
  query: mockQuery,
  pool: {},
  default: {},
  getClient: jest.fn(),
  withTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn({ query: clientQuery }),
}));
jest.unstable_mockModule('../services/notificationService.js', () => ({
  notificationService: { createNotification: mockCreateNotification },
}));

const { requireJwtAuth } = await import('../middleware/jwtAuth.js');
const { rotateApiKey } = await import('../services/apiKeyService.js');
const { notifyExpiringApiKeys } = await import('../controllers/keyRotationController.js');

function res() {
  const headers: Record<string, string> = {};
  return { headers, set: (k: string, v: string) => void (headers[k] = v) } as any;
}

describe('API key expiry (#792)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('rejects an expired key with 401 and WWW-Authenticate invalid_token', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ id: 1, owner: 'GA', scopes: [], expires_at: new Date(Date.now() - 1000), revoked_at: null }],
      rowCount: 1,
    });
    const r = res();
    await expect(
      requireJwtAuth({ headers: { authorization: 'Bearer rlk_abc' } } as any, r, jest.fn() as any),
    ).rejects.toMatchObject({ statusCode: 401 });
    expect(r.headers['WWW-Authenticate']).toBe('Bearer error="invalid_token"');
  });

  it('accepts a valid key', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ id: 1, owner: 'GA', scopes: ['read:loans'], expires_at: new Date(Date.now() + 1e6), revoked_at: null }],
      rowCount: 1,
    });
    const req: any = { headers: { authorization: 'Bearer rlk_abc' } };
    const next = jest.fn();
    await requireJwtAuth(req, res(), next as any);
    expect(next).toHaveBeenCalled();
    expect(req.user.publicKey).toBe('GA');
  });
});

describe('API key rotation (#792)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('revokes the old key and issues a new one with same scopes in one transaction', async () => {
    const created = new Date(Date.now() - 1000);
    clientQuery
      .mockResolvedValueOnce({
        rows: [{ scopes: ['read:loans'], created_at: created, expires_at: new Date(created.getTime() + 86400000) }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ id: 2 }], rowCount: 1 });
    const out = await rotateApiKey('GA', 1);
    expect(clientQuery.mock.calls[0]![0]).toContain('revoked_at = now()');
    expect(clientQuery.mock.calls[1]![0]).toContain('INSERT INTO api_keys');
    expect(clientQuery.mock.calls[1]![1]![3]).toEqual(['read:loans']);
    expect(mockQuery).not.toHaveBeenCalled(); // nothing outside the transaction
    expect(out.id).toBe(2);
    expect(out.key.startsWith('rlk_')).toBe(true);
  });

  it('404s when the key is missing or already revoked', async () => {
    clientQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(rotateApiKey('GA', 9)).rejects.toMatchObject({ statusCode: 404 });
    expect(clientQuery).toHaveBeenCalledTimes(1);
  });
});

describe('API key expiry notification (#792)', () => {
  it('notifies owners of keys expiring within 7 days and marks them notified', async () => {
    mockQuery.mockReset();
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ id: 5, owner: 'GA', key_prefix: 'rlk_abcd', expires_at: new Date(Date.now() + 6 * 86400000) }],
        rowCount: 1,
      })
      .mockResolvedValue({ rows: [], rowCount: 1 });
    expect(await notifyExpiringApiKeys()).toBe(1);
    expect(mockQuery.mock.calls[0]![1]).toEqual(['7']);
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'GA', type: 'api_key_expiring' }),
    );
    expect(mockQuery.mock.calls[1]![0]).toContain('expiry_notified_at');
  });
});
