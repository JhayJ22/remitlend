/**
 * Fault-injection tests — Outbound HTTP / fetch (WebhookService) (#402).
 *
 * Verifies that failed webhook deliveries (DNS failure, HTTP 5xx, rate-limit)
 * are persisted to the `webhook_deliveries` table for retry processing, and
 * that a failure for one subscriber does not prevent delivery to others.
 *
 * Threat-model notes
 * ------------------
 * Webhook delivery is fire-and-forget from the caller's perspective; consumers
 * can be temporarily unreachable. The service must:
 *   - Never throw to the event pipeline on delivery failure
 *   - Record the failure with HTTP status so retry backoff can be applied
 *   - Continue delivering to all other subscribers even if one is broken
 *
 * Compatibility impact: read-only unit test — no schema or contract changes.
 * Rollout steps: runs automatically in CI on every PR.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockQuery = jest.fn<(text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>>();

jest.unstable_mockModule('../db/connection.js', () => ({
  default: { query: mockQuery },
  query: mockQuery,
  getClient: jest.fn(),
  withTransaction: jest.fn(),
  closePool: jest.fn(),
}));

// DNS is mocked so tests never hit the network. Hostnames containing
// "internal-ip" resolve to an RFC 1918 address (DNS-based SSRF).
const mockLookup = jest.fn(async (hostname: string) =>
  hostname.includes('internal-ip')
    ? [{ address: '10.0.0.5', family: 4 }]
    : [{ address: '93.184.216.34', family: 4 }],
);
jest.unstable_mockModule('node:dns/promises', () => ({
  lookup: mockLookup,
  default: { lookup: mockLookup },
}));

// ─── Module under test ────────────────────────────────────────────────────────
const { WebhookService } = await import('../services/webhookService.js');
const { EgressPolicyViolation, validateWebhookUrl } = await import('../services/webhookEgress.js');

// ─── Shared fixture ───────────────────────────────────────────────────────────

const BASE_EVENT = {
  eventId: 'evt-fault-webhook-001',
  eventType: 'LoanApproved' as const,
  loanId: 1,
  address: 'GBORROWER_FAULT',
  ledger: 100,
  ledgerClosedAt: new Date('2025-01-01T00:00:00.000Z'),
  txHash: 'tx-fault-001',
  contractId: 'C_FAULT',
  topics: [] as unknown[],
  value: 'xdr',
};

const SUBSCRIBER = { id: 99, callback_url: 'https://consumer.example/hook', secret: null };

const originalFetch = global.fetch;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Fault injection – Outbound HTTP / fetch (WebhookService)', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    // Default: subscription lookup returns one subscriber
    mockQuery
      .mockResolvedValueOnce({ rows: [SUBSCRIBER] })
      .mockResolvedValueOnce({ rows: [] }); // delivery INSERT
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('does not throw when fetch rejects with a DNS error', async () => {
    global.fetch = jest
      .fn<typeof fetch>()
      .mockRejectedValue(
        new TypeError('fetch failed: ENOTFOUND consumer.example'),
      ) as typeof fetch;

    const service = new WebhookService();
    await expect(service.dispatch(BASE_EVENT)).resolves.not.toThrow();
  });

  it('records HTTP 503 status in webhook_deliveries INSERT', async () => {
    global.fetch = jest
      .fn<typeof fetch>()
      .mockResolvedValue({ ok: false, status: 503 } as Response) as typeof fetch;

    const service = new WebhookService();
    await service.dispatch(BASE_EVENT);

    const insertCall = mockQuery.mock.calls.find(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO webhook_deliveries'),
    );
    expect(insertCall).toBeDefined();
    expect(insertCall![1] as unknown[]).toContain(503);
  });

  it('records HTTP 429 (rate-limit) status in webhook_deliveries INSERT', async () => {
    global.fetch = jest
      .fn<typeof fetch>()
      .mockResolvedValue({ ok: false, status: 429 } as Response) as typeof fetch;

    const service = new WebhookService();
    await service.dispatch(BASE_EVENT);

    const insertCall = mockQuery.mock.calls.find(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO webhook_deliveries'),
    );
    expect(insertCall).toBeDefined();
    expect(insertCall![1] as unknown[]).toContain(429);
  });

  it('continues delivering to subsequent subscribers when one is unreachable', async () => {
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('ECONNREFUSED'))
      .mockResolvedValueOnce({ ok: true, status: 200 } as Response);
    global.fetch = fetchMock as typeof fetch;

    // Return two subscribers for this test
    mockQuery.mockReset();
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          { id: 1, callback_url: 'https://bad.example/hook', secret: null },
          { id: 2, callback_url: 'https://good.example/hook', secret: null },
        ],
      })
      .mockResolvedValue({ rows: [] });

    const service = new WebhookService();
    await service.dispatch(BASE_EVENT);

    // fetch must be called for both subscribers
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // ─── Egress policy (#784) ──────────────────────────────────────────────────

  it.each([
    ['RFC 1918 10.x', 'https://10.1.2.3/hook'],
    ['RFC 1918 172.16-31.x', 'https://172.20.0.1/hook'],
    ['RFC 1918 192.168.x', 'https://192.168.1.10/hook'],
    ['loopback', 'https://127.0.0.1/hook'],
    ['localhost', 'https://localhost/hook'],
    ['link-local / cloud metadata', 'https://169.254.169.254/latest/meta-data'],
    ['IPv6 loopback', 'https://[::1]/hook'],
    ['IPv4-mapped IPv6 private', 'https://[::ffff:10.0.0.1]/hook'],
    ['hostname resolving to private IP', 'https://internal-ip.example/hook'],
    ['plain HTTP', 'http://consumer.example/hook'],
  ])('rejects %s destinations with EgressPolicyViolation', async (_label, url) => {
    await expect(validateWebhookUrl(url)).rejects.toBeInstanceOf(EgressPolicyViolation);
  });

  it('accepts public HTTPS destinations', async () => {
    await expect(validateWebhookUrl('https://consumer.example/hook')).resolves.toBeUndefined();
  });

  it('enforces WEBHOOK_EGRESS_ALLOWLIST when configured', async () => {
    process.env.WEBHOOK_EGRESS_ALLOWLIST = '*.trusted.example,exact.example';
    try {
      await expect(validateWebhookUrl('https://api.trusted.example/hook')).resolves.toBeUndefined();
      await expect(validateWebhookUrl('https://exact.example/hook')).resolves.toBeUndefined();
      await expect(validateWebhookUrl('https://consumer.example/hook')).rejects.toBeInstanceOf(
        EgressPolicyViolation,
      );
    } finally {
      delete process.env.WEBHOOK_EGRESS_ALLOWLIST;
    }
  });

  it.each([
    ['private IP', 'https://192.168.0.10/hook'],
    ['non-HTTPS', 'http://consumer.example/hook'],
  ])('dead-letters %s deliveries without calling fetch', async (_label, callbackUrl) => {
    const fetchMock = jest.fn<typeof fetch>();
    global.fetch = fetchMock as typeof fetch;
    mockQuery.mockReset();
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 7, callback_url: callbackUrl, secret: null }] })
      .mockResolvedValue({ rows: [] });

    await new WebhookService().dispatch(BASE_EVENT);

    expect(fetchMock).not.toHaveBeenCalled();
    const insertCall = mockQuery.mock.calls.find(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO webhook_deliveries'),
    );
    expect(insertCall).toBeDefined();
    expect(insertCall![0]).toContain('dead_lettered_at');
    const params = insertCall![1] as unknown[];
    expect(String(params[3])).toMatch(/^EgressPolicyViolation:/);
    expect(params[5]).toBeInstanceOf(Date);
  });

  it('dead-letters a retry whose destination now violates policy', async () => {
    const fetchMock = jest.fn<typeof fetch>();
    global.fetch = fetchMock as typeof fetch;
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [] });

    await WebhookService.retryWebhookDelivery(
      42, 7, 'https://10.0.0.9/hook', undefined, 'evt-1', 'LoanApproved', { eventId: 'evt-1' }, 1,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    const update = mockQuery.mock.calls.find(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('UPDATE webhook_deliveries'),
    );
    expect(update).toBeDefined();
    expect(update![0]).toContain('dead_lettered_at = $3');
    expect(update![0]).toContain('next_retry_at = NULL');
  });
});
