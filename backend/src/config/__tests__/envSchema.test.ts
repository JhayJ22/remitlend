import { envSchema } from '../envSchema.js';

// Minimal set of required variables that the schema mandates (no defaults).
const REQUIRED: Record<string, string> = {
  CORS_ALLOWED_ORIGINS: 'http://localhost:3000',
  FRONTEND_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgres://user:pass@localhost:5432/test',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'a-secret-that-is-long-enough-16+',
  INTERNAL_API_KEY: 'test-internal-key',
  STELLAR_RPC_URL: 'https://soroban-testnet.stellar.org',
  STELLAR_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
  LOAN_MANAGER_CONTRACT_ID: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  LENDING_POOL_CONTRACT_ID: 'CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
  REMITTANCE_NFT_CONTRACT_ID: 'CDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD',
  MULTISIG_GOVERNANCE_CONTRACT_ID: 'CEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE',
  POOL_TOKEN_ADDRESS: 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
  LOAN_MANAGER_ADMIN_SECRET: 'SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  LOAN_MIN_SCORE: '500',
  LOAN_MAX_AMOUNT: '50000',
  LOAN_INTEREST_RATE_PERCENT: '12',
  CREDIT_SCORE_THRESHOLD: '600',
  SCORE_DELTA_REPAY: '15',
  SCORE_DELTA_DEFAULT: '50',
  SCORE_DELTA_LATE: '5',
};

function parse(overrides: Record<string, string | undefined> = {}) {
  return envSchema.safeParse({ ...REQUIRED, ...overrides });
}

// ── Success path ──────────────────────────────────────────────────────────────

describe('envSchema — success path', () => {
  it('accepts a valid minimal environment', () => {
    const result = parse();
    expect(result.success).toBe(true);
  });

  it('coerces string integers to numbers', () => {
    const result = parse({ PORT: '4000' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.PORT).toBe(4000);
      expect(typeof result.data.PORT).toBe('number');
    }
  });

  it('applies defaults for optional numeric fields', () => {
    const result = parse();
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.INDEXER_POLL_INTERVAL_MS).toBe(30000);
      expect(result.data.DB_CONN_TIMEOUT_MS).toBe(10000);
      expect(result.data.LOAN_TERM_LEDGERS).toBe(17280);
    }
  });

  it('coerces EXPOSE_STACK_TRACES "true" to boolean true', () => {
    const result = parse({ EXPOSE_STACK_TRACES: 'true' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.EXPOSE_STACK_TRACES).toBe(true);
    }
  });

  it('coerces EXPOSE_STACK_TRACES "false" to boolean false', () => {
    const result = parse({ EXPOSE_STACK_TRACES: 'false' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.EXPOSE_STACK_TRACES).toBe(false);
    }
  });

  it('accepts NODE_ENV "production"', () => {
    const result = parse({ NODE_ENV: 'production' });
    expect(result.success).toBe(true);
  });

  it('defaults NODE_ENV to "development" when absent', () => {
    const result = parse({ NODE_ENV: undefined });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.NODE_ENV).toBe('development');
    }
  });

  it('accepts STELLAR_NETWORK "mainnet"', () => {
    const result = parse({ STELLAR_NETWORK: 'mainnet' });
    expect(result.success).toBe(true);
  });
});

// ── Authorization / missing-required-var paths ────────────────────────────────

describe('envSchema — missing required variables', () => {
  const requiredKeys = [
    'DATABASE_URL',
    'REDIS_URL',
    'JWT_SECRET',
    'INTERNAL_API_KEY',
    'STELLAR_RPC_URL',
    'STELLAR_NETWORK_PASSPHRASE',
    'LOAN_MANAGER_CONTRACT_ID',
    'LENDING_POOL_CONTRACT_ID',
    'REMITTANCE_NFT_CONTRACT_ID',
    'MULTISIG_GOVERNANCE_CONTRACT_ID',
    'POOL_TOKEN_ADDRESS',
    'LOAN_MANAGER_ADMIN_SECRET',
    'FRONTEND_URL',
    'CORS_ALLOWED_ORIGINS',
  ];

  for (const key of requiredKeys) {
    it(`fails when ${key} is absent`, () => {
      const result = parse({ [key]: undefined });
      expect(result.success).toBe(false);
    });

    it(`fails when ${key} is empty string`, () => {
      const result = parse({ [key]: '' });
      expect(result.success).toBe(false);
    });
  }
});

// ── Boundary / type-coercion paths ────────────────────────────────────────────

describe('envSchema — boundary validation', () => {
  it('rejects PORT below 1', () => {
    const result = parse({ PORT: '0' });
    expect(result.success).toBe(false);
  });

  it('rejects PORT above 65535', () => {
    const result = parse({ PORT: '65536' });
    expect(result.success).toBe(false);
  });

  it('rejects LOAN_MIN_SCORE below 300', () => {
    const result = parse({ LOAN_MIN_SCORE: '299' });
    expect(result.success).toBe(false);
  });

  it('rejects LOAN_MIN_SCORE above 850', () => {
    const result = parse({ LOAN_MIN_SCORE: '851' });
    expect(result.success).toBe(false);
  });

  it('rejects LOAN_INTEREST_RATE_PERCENT above 100', () => {
    const result = parse({ LOAN_INTEREST_RATE_PERCENT: '101' });
    expect(result.success).toBe(false);
  });

  it('rejects LOAN_MAX_AMOUNT of 0', () => {
    const result = parse({ LOAN_MAX_AMOUNT: '0' });
    expect(result.success).toBe(false);
  });

  it('rejects non-integer PORT', () => {
    const result = parse({ PORT: 'abc' });
    expect(result.success).toBe(false);
  });

  it('accepts "3000.5" as PORT (parseInt truncates to 3000)', () => {
    // parseInt('3000.5') === 3000, which is a valid port — the schema does not
    // reject floats represented as strings because parseInt truncates them.
    // Callers should supply integer strings; this test documents the behaviour.
    const result = parse({ PORT: '3000.5' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.PORT).toBe(3000);
    }
  });

  it('rejects JWT_SECRET shorter than 16 chars', () => {
    const result = parse({ JWT_SECRET: 'tooshort' });
    expect(result.success).toBe(false);
  });

  it('rejects invalid NODE_ENV value', () => {
    const result = parse({ NODE_ENV: 'unknown' });
    expect(result.success).toBe(false);
  });

  it('rejects EXPOSE_STACK_TRACES with value other than "true"/"false"', () => {
    const result = parse({ EXPOSE_STACK_TRACES: 'yes' });
    expect(result.success).toBe(false);
  });

  it('rejects DATABASE_URL that is not a URL', () => {
    const result = parse({ DATABASE_URL: 'not-a-url' });
    expect(result.success).toBe(false);
  });
});

// ── Stale-data / dependency-failure simulation ─────────────────────────────────

describe('envSchema — dependency-failure paths', () => {
  it('collects ALL errors rather than stopping at the first', () => {
    const result = parse({
      DATABASE_URL: undefined,
      REDIS_URL: undefined,
      JWT_SECRET: undefined,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('DATABASE_URL');
      expect(paths).toContain('REDIS_URL');
      expect(paths).toContain('JWT_SECRET');
    }
  });

  it('returns structured Zod issues for tooling consumption', () => {
    const result = parse({ PORT: 'bad' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const portIssue = result.error.issues.find((i) => i.path.includes('PORT'));
      expect(portIssue).toBeDefined();
    }
  });
});

// ── Optional / default paths ──────────────────────────────────────────────────

describe('envSchema — optional fields with defaults', () => {
  it('applies default PORT 3001 when absent', () => {
    const result = parse({ PORT: undefined });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.PORT).toBe(3001);
    }
  });

  it('optional SENTRY_DSN absent → undefined', () => {
    const result = parse({ SENTRY_DSN: undefined });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.SENTRY_DSN).toBeUndefined();
    }
  });

  it('optional SENTRY_DSN present → preserved', () => {
    const result = parse({ SENTRY_DSN: 'https://abc@o1.ingest.sentry.io/1' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.SENTRY_DSN).toBe('https://abc@o1.ingest.sentry.io/1');
    }
  });
});
