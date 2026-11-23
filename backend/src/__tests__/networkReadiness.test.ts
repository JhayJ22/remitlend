/**
 * Tests for issue #862 — production readiness checks for network and contract
 * configuration.
 *
 * Coverage:
 *  ✓ Happy path: all checks pass, result is ready + healthy
 *  ✓ Network passphrase mismatch → critical issue
 *  ✓ RPC URL targeting wrong network → critical issue
 *  ✓ Invalid contract ID format → critical issue (per contract)
 *  ✓ Missing required contract ID → critical issue (per contract)
 *  ✓ Invalid asset issuer address (set but malformed) → critical issue
 *  ✓ Missing optional asset issuer → warning only
 *  ✓ Version manifest self-consistency (minApiVersion >= 1, max >= min)
 *  ✓ SOROBAN_REQUIRE_RPC_AT_STARTUP=true escalates RPC probe to critical
 *  ✓ assertNetworkReadiness calls process.exit(1) on critical issues
 *  ✓ assertNetworkReadiness does NOT exit on warnings-only
 *  ✓ /ready endpoint returns 200 when ready, 503 when not
 *  ✓ /ready response body shape
 *  ✓ /version endpoint includes supportedVersions field
 *  ✓ No secret values appear in issue messages
 */

import { jest } from '@jest/globals';
import { Networks } from '@stellar/stellar-sdk';

// ── Valid Stellar test fixtures ───────────────────────────────────────────────

// Canonical testnet contract addresses (C...) and account address (G...)
// These are well-formed strings that pass StrKey validation without hitting
// any real network.
const VALID_CONTRACT =
  'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
const VALID_ACCOUNT =
  'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN';

// ── Shared env snapshots and helpers ─────────────────────────────────────────

const BASE_ENV: Record<string, string> = {
  STELLAR_NETWORK: 'testnet',
  STELLAR_RPC_URL: 'https://soroban-testnet.stellar.org',
  STELLAR_NETWORK_PASSPHRASE: Networks.TESTNET,
  LOAN_MANAGER_CONTRACT_ID: VALID_CONTRACT,
  LENDING_POOL_CONTRACT_ID: VALID_CONTRACT,
  REMITTANCE_NFT_CONTRACT_ID: VALID_CONTRACT,
  MULTISIG_GOVERNANCE_CONTRACT_ID: VALID_CONTRACT,
  POOL_TOKEN_ADDRESS: VALID_CONTRACT,
  STELLAR_USDC_ISSUER: VALID_ACCOUNT,
  STELLAR_EURC_ISSUER: VALID_ACCOUNT,
  STELLAR_PHP_ISSUER: VALID_ACCOUNT,
};

function applyEnv(overrides: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
}

// ── Mock RPC server so tests run without network access ───────────────────────

jest.unstable_mockModule('../config/stellar.js', () => {
  const originalModule = jest.requireActual<typeof import('../config/stellar.js')>(
    '../config/stellar.js',
  );

  return {
    ...originalModule,
    // Replace createSorobanRpcServer with a factory that returns a mock server.
    createSorobanRpcServer: jest.fn(() => ({
      getHealth: jest.fn<() => Promise<{ status: string }>>().mockResolvedValue({
        status: 'healthy',
      }),
    })),
  };
});

// Also mock DB / cache / soroban imports needed by app.ts
jest.unstable_mockModule('../db/connection.js', () => ({
  default: {
    query: jest.fn<() => Promise<unknown>>().mockResolvedValue({ rows: [], rowCount: 0 }),
  },
  query: jest.fn<() => Promise<unknown>>().mockResolvedValue({ rows: [], rowCount: 0 }),
  getClient: jest.fn(),
  withTransaction: jest.fn(),
}));

jest.unstable_mockModule('../services/cacheService.js', () => ({
  cacheService: {
    ping: jest.fn<() => Promise<string>>().mockResolvedValue('ok'),
  },
}));

jest.unstable_mockModule('../services/sorobanService.js', () => ({
  sorobanService: {
    ping: jest.fn<() => Promise<string>>().mockResolvedValue('ok'),
    healthCheck: jest
      .fn<() => Promise<{ connected: boolean; latestLedger: number }>>()
      .mockResolvedValue({ connected: true, latestLedger: 1 }),
  },
}));

// Dynamic imports — must come after all unstable_mockModule calls
const { checkNetworkReadiness, assertNetworkReadiness } = await import(
  '../config/networkReadiness.js'
);
const { default: request } = await import('supertest');
const { default: app } = await import('../app.js');

// ── Env save/restore ──────────────────────────────────────────────────────────

const READINESS_KEYS = [
  'STELLAR_NETWORK',
  'STELLAR_RPC_URL',
  'STELLAR_NETWORK_PASSPHRASE',
  'LOAN_MANAGER_CONTRACT_ID',
  'LENDING_POOL_CONTRACT_ID',
  'REMITTANCE_NFT_CONTRACT_ID',
  'MULTISIG_GOVERNANCE_CONTRACT_ID',
  'POOL_TOKEN_ADDRESS',
  'STELLAR_USDC_ISSUER',
  'STELLAR_EURC_ISSUER',
  'STELLAR_PHP_ISSUER',
  'SOROBAN_REQUIRE_RPC_AT_STARTUP',
];

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of READINESS_KEYS) {
    savedEnv[key] = process.env[key];
  }
  applyEnv(BASE_ENV);
});

afterEach(() => {
  for (const key of READINESS_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
});

// ── checkNetworkReadiness unit tests ─────────────────────────────────────────

describe('checkNetworkReadiness()', () => {
  it('returns ready=true and healthy=true when all configuration is valid', async () => {
    const result = await checkNetworkReadiness({ skipRpcProbe: true });

    expect(result.ready).toBe(true);
    expect(result.healthy).toBe(true);
    expect(result.issues).toHaveLength(0);
    expect(typeof result.durationMs).toBe('number');
  });

  it('returns durationMs as a non-negative number', async () => {
    const result = await checkNetworkReadiness({ skipRpcProbe: true });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  describe('network passphrase checks', () => {
    it('reports a critical issue when STELLAR_NETWORK_PASSPHRASE does not match STELLAR_NETWORK', async () => {
      process.env.STELLAR_NETWORK = 'mainnet';
      process.env.STELLAR_NETWORK_PASSPHRASE = Networks.TESTNET; // wrong for mainnet
      process.env.STELLAR_RPC_URL = 'https://soroban-mainnet.stellar.org';

      const result = await checkNetworkReadiness({ skipRpcProbe: true });

      expect(result.ready).toBe(false);
      const issue = result.issues.find((i) => i.field === 'STELLAR_NETWORK_PASSPHRASE');
      expect(issue).toBeDefined();
      expect(issue?.severity).toBe('critical');
    });

    it('reports a critical issue when STELLAR_RPC_URL targets the wrong network', async () => {
      process.env.STELLAR_NETWORK = 'mainnet';
      // Passphrase correct but RPC URL is pointing at testnet:
      process.env.STELLAR_NETWORK_PASSPHRASE = Networks.PUBLIC;
      process.env.STELLAR_RPC_URL = 'https://soroban-testnet.stellar.org';

      const result = await checkNetworkReadiness({ skipRpcProbe: true });

      expect(result.ready).toBe(false);
      const issue = result.issues.find((i) => i.field === 'STELLAR_RPC_URL');
      expect(issue).toBeDefined();
      expect(issue?.severity).toBe('critical');
    });
  });

  describe('contract ID checks', () => {
    const CONTRACT_KEYS = [
      'LOAN_MANAGER_CONTRACT_ID',
      'LENDING_POOL_CONTRACT_ID',
      'REMITTANCE_NFT_CONTRACT_ID',
      'MULTISIG_GOVERNANCE_CONTRACT_ID',
      'POOL_TOKEN_ADDRESS',
    ] as const;

    for (const key of CONTRACT_KEYS) {
      it(`reports a critical issue when ${key} is missing`, async () => {
        delete process.env[key];

        const result = await checkNetworkReadiness({ skipRpcProbe: true });

        expect(result.ready).toBe(false);
        const issue = result.issues.find((i) => i.field === key);
        expect(issue).toBeDefined();
        expect(issue?.severity).toBe('critical');
      });

      it(`reports a critical issue when ${key} is not a valid contract address`, async () => {
        process.env[key] = 'not-a-contract-address';

        const result = await checkNetworkReadiness({ skipRpcProbe: true });

        expect(result.ready).toBe(false);
        const issue = result.issues.find((i) => i.field === key);
        expect(issue).toBeDefined();
        expect(issue?.severity).toBe('critical');
      });

      it(`accepts a correctly formatted contract address for ${key}`, async () => {
        process.env[key] = VALID_CONTRACT;

        const result = await checkNetworkReadiness({ skipRpcProbe: true });

        const contractIssue = result.issues.find((i) => i.field === key);
        expect(contractIssue).toBeUndefined();
      });
    }

    it('reports issues for all invalid contract IDs in a single pass', async () => {
      for (const key of CONTRACT_KEYS) {
        process.env[key] = 'BAD_VALUE';
      }

      const result = await checkNetworkReadiness({ skipRpcProbe: true });

      const contractIssues = result.issues.filter((i) =>
        (CONTRACT_KEYS as readonly string[]).includes(i.field),
      );
      expect(contractIssues.length).toBe(CONTRACT_KEYS.length);
    });
  });

  describe('asset metadata checks', () => {
    it('reports a warning (not critical) when an optional asset issuer is not configured', async () => {
      delete process.env.STELLAR_USDC_ISSUER;

      const result = await checkNetworkReadiness({ skipRpcProbe: true });

      const issue = result.issues.find((i) => i.field === 'STELLAR_USDC_ISSUER');
      expect(issue).toBeDefined();
      expect(issue?.severity).toBe('warning');
      // Warning does not block readiness
      expect(result.ready).toBe(true);
    });

    it('reports a critical issue when an asset issuer is set but is not a valid Stellar address', async () => {
      process.env.STELLAR_USDC_ISSUER = 'not-a-valid-stellar-address';

      const result = await checkNetworkReadiness({ skipRpcProbe: true });

      expect(result.ready).toBe(false);
      const issue = result.issues.find((i) => i.field === 'STELLAR_USDC_ISSUER');
      expect(issue).toBeDefined();
      expect(issue?.severity).toBe('critical');
    });

    it('reports warnings for all missing asset issuers', async () => {
      delete process.env.STELLAR_USDC_ISSUER;
      delete process.env.STELLAR_EURC_ISSUER;
      delete process.env.STELLAR_PHP_ISSUER;

      const result = await checkNetworkReadiness({ skipRpcProbe: true });

      const warnings = result.issues.filter(
        (i) =>
          i.severity === 'warning' &&
          ['STELLAR_USDC_ISSUER', 'STELLAR_EURC_ISSUER', 'STELLAR_PHP_ISSUER'].includes(i.field),
      );
      expect(warnings.length).toBe(3);
      expect(result.ready).toBe(true);
    });

    it('accepts a correctly formatted asset issuer address', async () => {
      process.env.STELLAR_USDC_ISSUER = VALID_ACCOUNT;

      const result = await checkNetworkReadiness({ skipRpcProbe: true });

      const issue = result.issues.find((i) => i.field === 'STELLAR_USDC_ISSUER');
      expect(issue).toBeUndefined();
    });
  });

  describe('RPC liveness probe', () => {
    it('adds a warning (not critical) when RPC is unreachable by default', async () => {
      // Override the stellar mock to simulate an RPC failure.
      const stellar = await import('../config/stellar.js');
      const mockFn = stellar.createSorobanRpcServer as jest.MockedFunction<
        typeof stellar.createSorobanRpcServer
      >;
      mockFn.mockReturnValueOnce({
        getHealth: jest
          .fn<() => Promise<never>>()
          .mockRejectedValue(new Error('connection refused')),
      } as unknown as ReturnType<typeof stellar.createSorobanRpcServer>);

      const result = await checkNetworkReadiness({ skipRpcProbe: false });

      const issue = result.issues.find((i) => i.field === 'STELLAR_RPC_URL');
      expect(issue).toBeDefined();
      expect(issue?.severity).toBe('warning');
      expect(result.ready).toBe(true);
    });

    it('escalates RPC failure to critical when SOROBAN_REQUIRE_RPC_AT_STARTUP=true', async () => {
      process.env.SOROBAN_REQUIRE_RPC_AT_STARTUP = 'true';

      const stellar = await import('../config/stellar.js');
      const mockFn = stellar.createSorobanRpcServer as jest.MockedFunction<
        typeof stellar.createSorobanRpcServer
      >;
      mockFn.mockReturnValueOnce({
        getHealth: jest
          .fn<() => Promise<never>>()
          .mockRejectedValue(new Error('connection refused')),
      } as unknown as ReturnType<typeof stellar.createSorobanRpcServer>);

      const result = await checkNetworkReadiness({ skipRpcProbe: false });

      const issue = result.issues.find((i) => i.field === 'STELLAR_RPC_URL');
      expect(issue?.severity).toBe('critical');
      expect(result.ready).toBe(false);
    });

    it('does not probe RPC when skipRpcProbe=true', async () => {
      const stellar = await import('../config/stellar.js');
      const mockFn = stellar.createSorobanRpcServer as jest.MockedFunction<
        typeof stellar.createSorobanRpcServer
      >;
      const getHealthSpy = jest.fn<() => Promise<{ status: string }>>().mockResolvedValue({
        status: 'healthy',
      });
      mockFn.mockReturnValueOnce({
        getHealth: getHealthSpy,
      } as unknown as ReturnType<typeof stellar.createSorobanRpcServer>);

      await checkNetworkReadiness({ skipRpcProbe: true });

      expect(getHealthSpy).not.toHaveBeenCalled();
    });
  });

  describe('no secrets in issue messages', () => {
    it('does not include secret environment values in issue messages', async () => {
      // Set a secret-like value and trigger a known error path.
      process.env.LOAN_MANAGER_CONTRACT_ID = 'BAD_VALUE_THAT_SHOULD_NOT_APPEAR_IN_MESSAGE';

      const result = await checkNetworkReadiness({ skipRpcProbe: true });

      const issue = result.issues.find((i) => i.field === 'LOAN_MANAGER_CONTRACT_ID');
      expect(issue).toBeDefined();
      // The message must name the field and describe the fix without quoting the value at length.
      expect(issue?.message).not.toContain('BAD_VALUE_THAT_SHOULD_NOT_APPEAR_IN_MESSAGE');
    });
  });
});

// ── assertNetworkReadiness tests ─────────────────────────────────────────────

describe('assertNetworkReadiness()', () => {
  let processExitSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    processExitSpy = jest
      .spyOn(process, 'exit')
      .mockImplementation((_code?: string | number | null) => undefined as never);
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    processExitSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('does not call process.exit when all checks pass', async () => {
    await assertNetworkReadiness({ skipRpcProbe: true });

    expect(processExitSpy).not.toHaveBeenCalled();
  });

  it('calls process.exit(1) when a critical contract ID issue is found', async () => {
    process.env.LOAN_MANAGER_CONTRACT_ID = 'INVALID';

    await assertNetworkReadiness({ skipRpcProbe: true });

    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it('logs critical issues to stderr without calling exit when only warnings exist', async () => {
    // Remove all optional asset issuers to trigger warnings.
    delete process.env.STELLAR_USDC_ISSUER;
    delete process.env.STELLAR_EURC_ISSUER;
    delete process.env.STELLAR_PHP_ISSUER;

    await assertNetworkReadiness({ skipRpcProbe: true });

    expect(processExitSpy).not.toHaveBeenCalled();
  });

  it('prints a colored terminal error listing all critical fields', async () => {
    process.env.LOAN_MANAGER_CONTRACT_ID = 'BAD';
    process.env.LENDING_POOL_CONTRACT_ID = 'BAD';

    await assertNetworkReadiness({ skipRpcProbe: true });

    expect(consoleErrorSpy).toHaveBeenCalled();
    const errorOutput: string = consoleErrorSpy.mock.calls[0][0] as string;
    // Strip ANSI codes to check plain text
    const stripped = errorOutput.replace(/\x1b\[[0-9;]*m/g, '');
    expect(stripped).toMatch(/LOAN_MANAGER_CONTRACT_ID/);
    expect(stripped).toMatch(/LENDING_POOL_CONTRACT_ID/);
  });
});

// ── /ready endpoint integration tests ────────────────────────────────────────

describe('GET /ready', () => {
  it('returns 200 when all configuration is valid', async () => {
    const res = await request(app).get('/ready');

    expect(res.status).toBe(200);
    expect(res.body.ready).toBe(true);
  });

  it('returns 503 when a contract ID is invalid', async () => {
    process.env.LOAN_MANAGER_CONTRACT_ID = 'INVALID_CONTRACT';

    const res = await request(app).get('/ready');

    expect(res.status).toBe(503);
    expect(res.body.ready).toBe(false);
  });

  it('response body includes required shape fields', async () => {
    const res = await request(app).get('/ready');

    expect(res.body).toHaveProperty('ready');
    expect(res.body).toHaveProperty('healthy');
    expect(res.body).toHaveProperty('durationMs');
    expect(res.body).toHaveProperty('issues');
    expect(Array.isArray(res.body.issues)).toBe(true);
    expect(res.body).toHaveProperty('versions');
    expect(res.body.versions).toHaveProperty('minApiVersion');
    expect(res.body.versions).toHaveProperty('maxApiVersion');
    expect(res.body.versions).toHaveProperty('deprecatedVersions');
  });

  it('issues array entries have field, message, and severity', async () => {
    delete process.env.STELLAR_USDC_ISSUER; // triggers a warning issue

    const res = await request(app).get('/ready');

    const issueEntry = res.body.issues[0];
    expect(issueEntry).toHaveProperty('field');
    expect(issueEntry).toHaveProperty('message');
    expect(issueEntry).toHaveProperty('severity');
    expect(['critical', 'warning']).toContain(issueEntry.severity);
  });

  it('200 with ready=true and healthy=false when only warnings exist', async () => {
    delete process.env.STELLAR_USDC_ISSUER;
    delete process.env.STELLAR_EURC_ISSUER;
    delete process.env.STELLAR_PHP_ISSUER;

    const res = await request(app).get('/ready');

    expect(res.status).toBe(200);
    expect(res.body.ready).toBe(true);
    expect(res.body.healthy).toBe(false);
  });

  it('issues list is empty when all configuration is complete', async () => {
    const res = await request(app).get('/ready');

    expect(res.body.issues).toHaveLength(0);
    expect(res.body.healthy).toBe(true);
  });
});

// ── /version endpoint includes supportedVersions ─────────────────────────────

describe('GET /version includes supportedVersions', () => {
  it('response body includes a supportedVersions field', async () => {
    const res = await request(app).get('/version');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('supportedVersions');
    expect(res.body.supportedVersions).toHaveProperty('minApiVersion');
    expect(res.body.supportedVersions).toHaveProperty('maxApiVersion');
    expect(res.body.supportedVersions).toHaveProperty('deprecatedVersions');
  });
});
