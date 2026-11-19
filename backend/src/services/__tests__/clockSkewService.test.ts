import {
  ClockSkewService,
  ClockSkewError,
  AuthoritativeTimestampPolicy,
  AuthoritativeSourceUnavailableError,
  SkewThresholdExceededError,
  StaleActionError,
  AccessDeniedError,
  type ClockSource,
  type AuthoritativeTimestampRecord,
} from '../clockSkewService';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

class FakeClockSource implements ClockSource {
  constructor(public name: string, private nowMs: number, private available = true) {}

  async now(): Promise<number> {
    if (!this.available) {
      throw new AuthoritativeSourceUnavailableError(this.name);
    }
    return this.nowMs;
  }

  setNow(ms: number): void {
    this.nowMs = ms;
  }

  setAvailable(available: boolean): void {
    this.available = available;
  }
}

const BASE_MS = 1_700_000_000_000; // fixed reference instant

function makeService(overrides?: {
  localNow?: number;
  providerNow?: number;
  providerAvailable?: boolean;
  maxSkewMs?: number;
}) {
  const local = new FakeClockSource('local', overrides?.localNow ?? BASE_MS);
  const provider = new FakeClockSource(
    'provider',
    overrides?.providerNow ?? BASE_MS,
    overrides?.providerAvailable ?? true,
  );
  const service = new ClockSkewService({
    sources: [local, provider],
    authoritativeSource: 'provider',
    maxSkewMs: overrides?.maxSkewMs ?? 5_000,
  });
  return { service, local, provider };
}

// ---------------------------------------------------------------------------
// ClockSkewService: measurement
// ---------------------------------------------------------------------------

describe('ClockSkewService measurement', () => {
  it('reports zero skew when all sources agree', async () => {
    const { service } = makeService();
    const report = await service.measureSkew();
    expect(report.authoritativeSource).toBe('provider');
    expect(report.authoritativeNowMs).toBe(BASE_MS);
    expect(report.skews).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'local', skewMs: 0, exceedsThreshold: false }),
        expect.objectContaining({ source: 'provider', skewMs: 0, exceedsThreshold: false }),
      ]),
    );
    expect(report.thresholdExceeded).toBe(false);
  });

  it('flags skew exactly at the threshold boundary as exceeding', async () => {
    const { service } = makeService({ providerNow: BASE_MS + 5_000 });
    const report = await service.measureSkew();
    const local = report.skews.find((s) => s.source === 'local');
    expect(local?.skewMs).toBe(5_000);
    expect(local?.exceedsThreshold).toBe(true);
    expect(report.thresholdExceeded).toBe(true);
  });

  it('does not flag skew just below the threshold', async () => {
    const { service } = makeService({ providerNow: BASE_MS + 4_999 });
    const report = await service.measureSkew();
    const local = report.skews.find((s) => s.source === 'local');
    expect(local?.skewMs).toBe(4_999);
    expect(local?.exceedsThreshold).toBe(false);
    expect(report.thresholdExceeded).toBe(false);
  });

  it('measures negative skew symmetrically', async () => {
    const { service } = makeService({ providerNow: BASE_MS - 5_000 });
    const report = await service.measureSkew();
    const local = report.skews.find((s) => s.source === 'local');
    expect(local?.skewMs).toBe(-5_000);
    expect(local?.exceedsThreshold).toBe(true);
  });

  it('throws when the authoritative source is unavailable', async () => {
    const { service } = makeService({ providerAvailable: false });
    await expect(service.measureSkew()).rejects.toBeInstanceOf(
      AuthoritativeSourceUnavailableError,
    );
  });

  it('throws SkewThresholdExceededError when enforcing and skew exceeds threshold', async () => {
    const { service } = makeService({ providerNow: BASE_MS + 10_000 });
    await expect(service.assertSkewWithinThreshold()).rejects.toBeInstanceOf(
      SkewThresholdExceededError,
    );
  });

  it('resolves assertSkewWithinThreshold when skew is within threshold', async () => {
    const { service } = makeService({ providerNow: BASE_MS + 1_000 });
    await expect(service.assertSkewWithinThreshold()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AuthoritativeTimestampPolicy: authoritative source per workflow
// ---------------------------------------------------------------------------

describe('AuthoritativeTimestampPolicy', () => {
  function makePolicy(overrides?: {
    providerNow?: number;
    providerAvailable?: boolean;
    maxSkewMs?: number;
  }) {
    const local = new FakeClockSource('local', BASE_MS);
    const provider = new FakeClockSource(
      'provider',
      overrides?.providerNow ?? BASE_MS,
      overrides?.providerAvailable ?? true,
    );
    const skewService = new ClockSkewService({
      sources: [local, provider],
      authoritativeSource: 'provider',
      maxSkewMs: overrides?.maxSkewMs ?? 5_000,
    });
    const policy = new AuthoritativeTimestampPolicy({
      skewService,
      workflowAuthorities: {
        quote: 'provider',
        nonce: 'provider',
        authorization: 'provider',
      },
    });
    return { policy, local, provider, skewService };
  }

  it('returns the authoritative timestamp for a workflow', async () => {
    const { policy } = makePolicy();
    const record: AuthoritativeTimestampRecord = await policy.authoritativeNow('quote');
    expect(record.workflow).toBe('quote');
    expect(record.source).toBe('provider');
    expect(record.nowMs).toBe(BASE_MS);
  });

  it('rejects unknown workflows', async () => {
    const { policy } = makePolicy();
    await expect(
      policy.authoritativeNow('unknown' as unknown as 'quote'),
    ).rejects.toBeInstanceOf(ClockSkewError);
  });

  it('fails closed when the authoritative source is unavailable', async () => {
    const { policy } = makePolicy({ providerAvailable: false });
    await expect(policy.authoritativeNow('nonce')).rejects.toBeInstanceOf(
      AuthoritativeSourceUnavailableError,
    );
  });
});

// ---------------------------------------------------------------------------
// Skew cannot extend quote validity
// ---------------------------------------------------------------------------

describe('skew cannot extend quote validity', () => {
  it('rejects a quote whose validity would be extended by a fast local clock', async () => {
    // Provider (authoritative) says the quote has expired; local clock is behind
    // and would otherwise consider it still valid.
    const providerNow = BASE_MS + 60_000;
    const { policy } = makePolicy({ providerNow });
    const quoteExpiresAtMs = BASE_MS + 30_000;

    const result = await policy.validateQuote({
      quoteId: 'q_1',
      expiresAtMs: quoteExpiresAtMs,
    });

    expect(result.valid).toBe(false);
    expect(result.reason).toBe('expired');
    expect(result.evaluatedAtMs).toBe(providerNow);
  });

  it('accepts a quote still within validity per the authoritative clock', async () => {
    const providerNow = BASE_MS + 10_000;
    const { policy } = makePolicy({ providerNow });
    const result = await policy.validateQuote({
      quoteId: 'q_2',
      expiresAtMs: BASE_MS + 30_000,
    });
    expect(result.valid).toBe(true);
    expect(result.evaluatedAtMs).toBe(providerNow);
  });

  it('treats the exact expiry instant as expired (boundary)', async () => {
    const providerNow = BASE_MS + 30_000;
    const { policy } = makePolicy({ providerNow });
    const result = await policy.validateQuote({
      quoteId: 'q_3',
      expiresAtMs: BASE_MS + 30_000,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('expired');
  });

  it('rejects a quote when skew exceeds threshold even if not yet expired', async () => {
    const providerNow = BASE_MS + 10_000;
    const { policy } = makePolicy({ providerNow, maxSkewMs: 1_000 });
    await expect(
      policy.validateQuote({ quoteId: 'q_4', expiresAtMs: BASE_MS + 30_000 }),
    ).rejects.toBeInstanceOf(SkewThresholdExceededError);
  });
});

// ---------------------------------------------------------------------------
// Skew cannot extend nonce validity
// ---------------------------------------------------------------------------

describe('skew cannot extend nonce validity', () => {
  it('rejects a nonce consumed after its authoritative expiry', async () => {
    const providerNow = BASE_MS + 120_000;
    const { policy } = makePolicy({ providerNow });
    const result = await policy.validateNonce({
      nonce: 'n_1',
      issuedAtMs: BASE_MS,
      ttlMs: 60_000,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('expired');
  });

  it('accepts a nonce within its authoritative TTL', async () => {
    const providerNow = BASE_MS + 30_000;
    const { policy } = makePolicy({ providerNow });
    const result = await policy.validateNonce({
      nonce: 'n_2',
      issuedAtMs: BASE_MS,
      ttlMs: 60_000,
    });
    expect(result.valid).toBe(true);
  });

  it('rejects a nonce issued in the future relative to authoritative clock', async () => {
    const providerNow = BASE_MS;
    const { policy } = makePolicy({ providerNow });
    const result = await policy.validateNonce({
      nonce: 'n_3',
      issuedAtMs: BASE_MS + 10_000,
      ttlMs: 60_000,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('not_yet_valid');
  });

  it('rejects a replayed nonce (idempotency/retry)', async () => {
    const providerNow = BASE_MS + 1_000;
    const { policy } = makePolicy({ providerNow });
    const first = await policy.validateNonce({
      nonce: 'n_replay',
      issuedAtMs: BASE_MS,
      ttlMs: 60_000,
    });
    expect(first.valid).toBe(true);

    const second = await policy.validateNonce({
      nonce: 'n_replay',
      issuedAtMs: BASE_MS,
      ttlMs: 60_000,
    });
    expect(second.valid).toBe(false);
    expect(second.reason).toBe('replayed');
  });

  it('is idempotent for concurrent retries of the same nonce', async () => {
    const providerNow = BASE_MS + 1_000;
    const { policy } = makePolicy({ providerNow });
    const results = await Promise.all([
      policy.validateNonce({ nonce: 'n_concurrent', issuedAtMs: BASE_MS, ttlMs: 60_000 }),
      policy.validateNonce({ nonce: 'n_concurrent', issuedAtMs: BASE_MS, ttlMs: 60_000 }),
    ]);
    const validCount = results.filter((r) => r.valid).length;
    expect(validCount).toBe(1);
    expect(results.filter((r) => r.reason === 'replayed').length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Skew cannot extend authorization validity
// ---------------------------------------------------------------------------

describe('skew cannot extend authorization validity', () => {
  it('rejects an authorization whose window has closed per authoritative clock', async () => {
    const providerNow = BASE_MS + 300_000;
    const { policy } = makePolicy({ providerNow });
    const result = await policy.validateAuthorization({
      authorizationId: 'a_1',
      grantedAtMs: BASE_MS,
      expiresAtMs: BASE_MS + 120_000,
      subject: 'user_1',
      requiredSubject: 'user_1',
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('expired');
  });

  it('accepts an authorization within its window', async () => {
    const providerNow = BASE_MS + 60_000;
    const { policy } = makePolicy({ providerNow });
    const result = await policy.validateAuthorization({
      authorizationId: 'a_2',
      grantedAtMs: BASE_MS,
      expiresAtMs: BASE_MS + 120_000,
      subject: 'user_1',
      requiredSubject: 'user_1',
    });
    expect(result.valid).toBe(true);
  });

  it('rejects an authorization for a mismatched subject (access control)', async () => {
    const providerNow = BASE_MS + 60_000;
    const { policy } = makePolicy({ providerNow });
    const result = await policy.validateAuthorization({
      authorizationId: 'a_3',
      grantedAtMs: BASE_MS,
      expiresAtMs: BASE_MS + 120_000,
      subject: 'user_1',
      requiredSubject: 'user_2',
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('subject_mismatch');
  });

  it('throws AccessDeniedError when enforcing a mismatched subject', async () => {
    const providerNow = BASE_MS + 60_000;
    const { policy } = makePolicy({ providerNow });
    await expect(
      policy.assertAuthorization({
        authorizationId: 'a_4',
        grantedAtMs: BASE_MS,
        expiresAtMs: BASE_MS + 120_000,
        subject: 'user_1',
        requiredSubject: 'user_2',
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it('throws StaleActionError when enforcing an expired authorization', async () => {
    const providerNow = BASE_MS + 300_000;
    const { policy } = makePolicy({ providerNow });
    await expect(
      policy.assertAuthorization({
        authorizationId: 'a_5',
        grantedAtMs: BASE_MS,
        expiresAtMs: BASE_MS + 120_000,
        subject: 'user_1',
        requiredSubject: 'user_1',
      }),
    ).rejects.toBeInstanceOf(StaleActionError);
  });

  it('fails closed when the authoritative source is unavailable during authorization', async () => {
    const { policy } = makePolicy({ providerAvailable: false });
    await expect(
      policy.assertAuthorization({
        authorizationId: 'a_6',
        grantedAtMs: BASE_MS,
        expiresAtMs: BASE_MS + 120_000,
        subject: 'user_1',
        requiredSubject: 'user_1',
      }),
    ).rejects.toBeInstanceOf(AuthoritativeSourceUnavailableError);
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: no partial financial side effects on rejection
// ---------------------------------------------------------------------------

describe('rejections do not produce partial side effects', () => {
  it('does not invoke the side-effect callback when validation fails', async () => {
    const providerNow = BASE_MS + 300_000;
    const { policy } = makePolicy({ providerNow });
    const sideEffect = jest.fn();

    await expect(
      policy.withValidatedAction(
        {
          kind: 'authorization',
          authorizationId: 'a_7',
          grantedAtMs: BASE_MS,
          expiresAtMs: BASE_MS + 120_000,
          subject: 'user_1',
          requiredSubject: 'user_1',
        },
        sideEffect,
      ),
    ).rejects.toBeInstanceOf(StaleActionError);

    expect(sideEffect).not.toHaveBeenCalled();
  });

  it('invokes the side-effect callback exactly once on success', async () => {
    const providerNow = BASE_MS + 60_000;
    const { policy } = makePolicy({ providerNow });
    const sideEffect = jest.fn().mockResolvedValue('ok');

    const result = await policy.withValidatedAction(
      {
        kind: 'authorization',
        authorizationId: 'a_8',
        grantedAtMs: BASE_MS,
        expiresAtMs: BASE_MS + 120_000,
        subject: 'user_1',
        requiredSubject: 'user_1',
      },
      sideEffect,
    );

    expect(result).toBe('ok');
    expect(sideEffect).toHaveBeenCalledTimes(1);
  });
});