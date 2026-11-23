import { describe, it, expect, jest } from '@jest/globals';

jest.unstable_mockModule('../../db/connection.js', () => ({
  default: { query: jest.fn(), on: jest.fn(), connect: jest.fn() },
  query: jest.fn(),
  pool: { on: jest.fn(), connect: jest.fn() },
}));

jest.unstable_mockModule('../../services/cacheService.js', () => ({
  cacheService: { get: jest.fn(), set: jest.fn() },
}));

const { AbuseTelemetryService, bucketRate, deriveRiskTier } =
  await import('../abuseTelemetryService.js');

const NOW = new Date('2026-06-15T12:34:56.000Z');
const PEPPER = 'test-pepper';

function makeService(overrides: Record<string, unknown> = {}) {
  const counter = { increment: jest.fn(async () => 1) };
  const queryFn = jest.fn(async () => ({ rows: [], rowCount: 0 }));
  const service = new AbuseTelemetryService({
    counter,
    queryFn,
    now: () => NOW,
    pepper: PEPPER,
    retentionDays: 7,
    ...overrides,
  });
  return { service, counter, queryFn };
}

describe('privacy-safe abuse telemetry — derivation boundaries', () => {
  it('derives a deterministic one-way actor reference without leaking the actor', () => {
    const { service } = makeService();
    const hash = service.deriveActorHash('GACTORPUBLICKEY123');

    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain('GACTORPUBLICKEY123');
    expect(hash).toBe(service.deriveActorHash('GACTORPUBLICKEY123'));
    expect(hash).not.toBe(service.deriveActorHash('GOTHERACTOR'));
    expect(hash).not.toBe(
      service.deriveActorHash('GACTORPUBLICKEY123', new Date('2026-06-16T00:00:00Z')),
    );
  });

  it('buckets attempt rates at the documented boundaries', () => {
    expect(bucketRate(0)).toBe('one');
    expect(bucketRate(1)).toBe('one');
    expect(bucketRate(2)).toBe('few');
    expect(bucketRate(5)).toBe('few');
    expect(bucketRate(6)).toBe('many');
    expect(bucketRate(20)).toBe('many');
    expect(bucketRate(21)).toBe('burst');
  });

  it('derives coarse risk tiers from the rate band only', () => {
    expect(deriveRiskTier('one')).toBe('low');
    expect(deriveRiskTier('few')).toBe('low');
    expect(deriveRiskTier('many')).toBe('medium');
    expect(deriveRiskTier('burst')).toBe('high');
  });
});

describe('privacy-safe abuse telemetry — evaluation', () => {
  it('allows up to the block threshold and blocks the next attempt', async () => {
    let attempts = 0;
    const counter = { increment: jest.fn(async () => ++attempts) };
    const { service } = makeService({ counter });

    for (let i = 1; i <= 20; i += 1) {
      const result = await service.evaluate({ actorId: 'GACTOR', mutationType: 'loan_repay' });
      expect(result.decision).toBe('allow');
      expect(result.attemptsInWindow).toBe(i);
    }

    const blocked = await service.evaluate({ actorId: 'GACTOR', mutationType: 'loan_repay' });
    expect(blocked.decision).toBe('block');
    expect(blocked.rateBand).toBe('burst');
    expect(blocked.riskTier).toBe('high');
    expect(blocked.dependencyError).toBe(false);
  });

  it('does not count an idempotent replay as a new attempt', async () => {
    const { service, counter } = makeService();

    const result = await service.evaluate({
      actorId: 'GACTOR',
      mutationType: 'remittance_create',
      isReplay: true,
    });

    expect(result.decision).toBe('allow');
    expect(result.attemptsInWindow).toBe(1);
    expect(counter.increment).not.toHaveBeenCalled();
  });

  it('fails open with an explicit dependency-error signal when the counter fails', async () => {
    const counter = {
      increment: jest.fn(async () => {
        throw new Error('redis down');
      }),
    };
    const { service } = makeService({ counter });

    const result = await service.evaluate({ actorId: 'GACTOR', mutationType: 'loan_request' });

    expect(result.dependencyError).toBe(true);
    expect(result.decision).toBe('allow');
    expect(result.attemptsInWindow).toBe(1);
    expect(result.rateBand).toBe('one');
  });
});

describe('privacy-safe abuse telemetry — persistence', () => {
  it('persists only allow-listed coarse fields with a bounded expiry', async () => {
    const { service, queryFn } = makeService();

    const ok = await service.record({
      actorHash: service.deriveActorHash('GACTOR'),
      mutationType: 'loan_submit',
      decision: 'allow',
      outcome: 'success',
      riskTier: 'low',
      rateBand: 'one',
      attemptsInWindow: 1,
    });

    expect(ok).toBe(true);
    const [sql, values] = queryFn.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO abuse_telemetry_events');
    expect(sql).toContain('ON CONFLICT (event_id) DO NOTHING');
    expect(values).toHaveLength(10);
    expect(values[1]).toMatch(/^[a-f0-9]{64}$/);
    expect(values[5]).toBe('low');
    expect(values[9]).toBe('2026-06-22T12:34:56.000Z');
    expect(JSON.stringify(values)).not.toContain('GACTOR');
  });

  it('never throws to callers when persistence is unavailable', async () => {
    const queryFn = jest.fn(async () => {
      throw new Error('db down');
    });
    const { service } = makeService({ queryFn });

    await expect(
      service.record({
        actorHash: service.deriveActorHash('GACTOR'),
        mutationType: 'loan_repay',
        decision: 'allow',
        outcome: 'success',
        riskTier: 'low',
        rateBand: 'one',
        attemptsInWindow: 1,
      }),
    ).resolves.toBe(false);
  });

  it('reports aggregates and coarse events without actor references', async () => {
    const queryFn = jest
      .fn<() => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number }>>()
      .mockResolvedValueOnce({
        rows: [
          {
            mutation_type: 'loan_repay',
            decision: 'allow',
            outcome: 'success',
            risk_tier: 'low',
            rate_band: 'one',
            attempts_in_window: 1,
            occurred_at: NOW,
          },
        ],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [
          {
            total: 4,
            blocked: 1,
            success: 2,
            failure: 1,
            outcome_blocked: 1,
            low: 2,
            medium: 1,
            high: 1,
          },
        ],
        rowCount: 1,
      });
    const { service } = makeService({ queryFn });

    const report = await service.getReport({ riskTier: 'low', limit: 10 });

    expect(report.retentionDays).toBe(7);
    expect(report.summary).toEqual({
      total: 4,
      blocked: 1,
      byOutcome: { success: 2, failure: 1, blocked: 1 },
      byRiskTier: { low: 2, medium: 1, high: 1 },
    });
    expect(report.events[0]).toEqual({
      mutationType: 'loan_repay',
      decision: 'allow',
      outcome: 'success',
      riskTier: 'low',
      rateBand: 'one',
      attemptsInWindow: 1,
      occurredAt: NOW.toISOString(),
    });
    expect(JSON.stringify(report)).not.toContain('actorHash');
    expect(JSON.stringify(report)).not.toContain('expiresAt');
  });

  it('purges expired rows using the retention column', async () => {
    const queryFn = jest.fn(async () => ({ rows: [], rowCount: 3 }));
    const { service } = makeService({ queryFn });

    await expect(service.purgeExpired()).resolves.toBe(3);
    expect(queryFn).toHaveBeenCalledWith(
      'DELETE FROM abuse_telemetry_events WHERE expires_at <= NOW()',
      [],
    );
  });
});
