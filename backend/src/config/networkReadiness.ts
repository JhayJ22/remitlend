/**
 * Production readiness checks for network and contract configuration.
 *
 * Issue #862 — validate network passphrase, RPC endpoint, contract IDs,
 * asset metadata, and the supported-version manifest before serving financial
 * routes.  All check results are reported as structured, actionable errors
 * that name the offending configuration key WITHOUT echoing secret values.
 *
 * Design
 * ──────
 * - `checkNetworkReadiness()` returns a typed result object so callers decide
 *   whether to abort startup or switch to degraded mode.
 * - `assertNetworkReadiness()` wraps it and calls `process.exit(1)` on a
 *   critical failure, mirroring the pattern used by `validateLoanConfigOnStartup`.
 * - Each check is independent so a partial failure report names every broken
 *   configuration key rather than stopping at the first error.
 * - No secret values (private keys, API keys) are included in any log line or
 *   error message produced by this module.
 */

import { StrKey } from '@stellar/stellar-sdk';
import logger from '../utils/logger.js';
import { getStellarConfig, createSorobanRpcServer } from './stellar.js';

// ── Types ─────────────────────────────────────────────────────────────────────

/** Severity of an individual readiness failure. */
export type ReadinessSeverity = 'critical' | 'warning';

/** A single actionable finding from a readiness check. */
export interface ReadinessIssue {
  /** The configuration variable or area that has the problem. */
  field: string;
  /** Human-readable description of what is wrong and how to fix it. */
  message: string;
  /** Whether this issue must be resolved before serving financial routes. */
  severity: ReadinessSeverity;
}

/** Full result returned by `checkNetworkReadiness()`. */
export interface NetworkReadinessResult {
  /** True only when there are no critical issues. */
  ready: boolean;
  /** True only when ALL checks pass (no critical or warning issues). */
  healthy: boolean;
  /** Ordered list of issues found. Empty when healthy. */
  issues: ReadinessIssue[];
  /** Milliseconds the check took to run. */
  durationMs: number;
}

// ── Supported-version manifest ───────────────────────────────────────────────

/**
 * Minimum and maximum API versions the backend currently serves.
 * Bump `maxApiVersion` on each new versioned-API release and update
 * `minApiVersion` when an older version is retired.
 */
export const SUPPORTED_API_VERSION_MANIFEST = {
  minApiVersion: 1,
  maxApiVersion: 1,
  deprecatedVersions: [] as number[],
} as const;

export type SupportedVersionManifest = typeof SUPPORTED_API_VERSION_MANIFEST;

// ── Contract ID catalogue ────────────────────────────────────────────────────

/**
 * Names and environment-variable keys for every contract the backend depends
 * on.  `required` controls whether a missing or invalid value is a critical
 * failure vs. a warning.
 */
const CONTRACT_CHECKS = [
  {
    envKey: 'LOAN_MANAGER_CONTRACT_ID',
    label: 'Loan Manager contract',
    required: true,
  },
  {
    envKey: 'LENDING_POOL_CONTRACT_ID',
    label: 'Lending Pool contract',
    required: true,
  },
  {
    envKey: 'REMITTANCE_NFT_CONTRACT_ID',
    label: 'Remittance NFT contract',
    required: true,
  },
  {
    envKey: 'MULTISIG_GOVERNANCE_CONTRACT_ID',
    label: 'Multisig Governance contract',
    required: true,
  },
  {
    envKey: 'POOL_TOKEN_ADDRESS',
    label: 'Pool Token address',
    required: true,
  },
] as const satisfies ReadonlyArray<{
  envKey: string;
  label: string;
  required: boolean;
}>;

// ── Asset metadata catalogue ──────────────────────────────────────────────────

/**
 * Supported non-native currency tokens.  Issuers are optional — the service
 * starts without them but remittance routes that use the missing currency will
 * fail at request time.  An issuer that IS set but is not a valid Stellar
 * account address is always a critical failure.
 */
const ASSET_CHECKS = [
  { envKey: 'STELLAR_USDC_ISSUER', label: 'USDC issuer' },
  { envKey: 'STELLAR_EURC_ISSUER', label: 'EURC issuer' },
  { envKey: 'STELLAR_PHP_ISSUER', label: 'PHP issuer' },
] as const satisfies ReadonlyArray<{ envKey: string; label: string }>;

// ── Individual check helpers ───────────────────────────────────────────────────

function checkNetworkPassphraseAndRpcConfig(issues: ReadinessIssue[]): {
  rpcReachable: boolean | null;
} {
  let rpcReachable: boolean | null = null;

  try {
    getStellarConfig();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Classify: passphrase/network mismatch and RPC-URL problems are critical.
    issues.push({
      field:
        msg.includes('STELLAR_NETWORK_PASSPHRASE') || msg.includes('passphrase')
          ? 'STELLAR_NETWORK_PASSPHRASE'
          : msg.includes('STELLAR_RPC_URL') || msg.includes('rpcUrl') || msg.includes('RPC_URL')
            ? 'STELLAR_RPC_URL'
            : 'STELLAR_NETWORK',
      message: msg,
      severity: 'critical',
    });
    // Cannot proceed to RPC probe if config itself is invalid.
    return { rpcReachable: false };
  }

  rpcReachable = null; // unknown until probed
  return { rpcReachable };
}

async function probeRpcEndpoint(issues: ReadinessIssue[]): Promise<boolean> {
  const rpcUrl = process.env.STELLAR_RPC_URL ?? 'https://soroban-testnet.stellar.org';

  try {
    const server = createSorobanRpcServer();
    await server.getHealth();
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // RPC probe failure is a warning by default (degraded mode supported).
    // Becomes critical only when SOROBAN_REQUIRE_RPC_AT_STARTUP=true.
    const severity: ReadinessSeverity =
      process.env.SOROBAN_REQUIRE_RPC_AT_STARTUP === 'true' ? 'critical' : 'warning';

    issues.push({
      field: 'STELLAR_RPC_URL',
      message:
        `Stellar RPC endpoint is unreachable at startup (${rpcUrl}): ${msg}. ` +
        'The service will start in degraded mode; signed transactions will be queued for replay. ' +
        'Set SOROBAN_REQUIRE_RPC_AT_STARTUP=true to make an unreachable RPC a fatal error.',
      severity,
    });
    return false;
  }
}

function checkContractIds(issues: ReadinessIssue[]): void {
  for (const { envKey, label, required } of CONTRACT_CHECKS) {
    const value = process.env[envKey]?.trim() ?? '';

    if (!value) {
      issues.push({
        field: envKey,
        message: `${label} (${envKey}) is not configured. Set the deployed contract address before serving financial routes.`,
        severity: required ? 'critical' : 'warning',
      });
      continue;
    }

    if (!StrKey.isValidContract(value)) {
      issues.push({
        field: envKey,
        message:
          `${label} (${envKey}) is set but is not a valid Stellar contract address. ` +
          'Contract addresses must be 56-character C... strings. ' +
          `Current value length: ${value.length} chars.`,
        severity: 'critical',
      });
    }
  }
}

function checkAssetMetadata(issues: ReadinessIssue[]): void {
  for (const { envKey, label } of ASSET_CHECKS) {
    const value = process.env[envKey]?.trim();

    // Absent issuers are warned about but not critical — routes that need them
    // will fail at request time with a clear per-request error.
    if (!value) {
      issues.push({
        field: envKey,
        message:
          `${label} (${envKey}) is not configured. ` +
          'Remittance routes using this currency will reject requests at runtime.',
        severity: 'warning',
      });
      continue;
    }

    // A set issuer that is not a valid Stellar account address IS critical —
    // it proves the deployment is misconfigured rather than simply incomplete.
    if (!StrKey.isValidEd25519PublicKey(value)) {
      issues.push({
        field: envKey,
        message:
          `${label} (${envKey}) is set but is not a valid Stellar account address (G...). ` +
          'Update it to the correct issuer account public key.',
        severity: 'critical',
      });
    }
  }
}

function checkVersionManifest(issues: ReadinessIssue[]): void {
  const { minApiVersion, maxApiVersion } = SUPPORTED_API_VERSION_MANIFEST;

  if (minApiVersion < 1) {
    issues.push({
      field: 'SUPPORTED_API_VERSION_MANIFEST.minApiVersion',
      message: `minApiVersion must be >= 1; got ${minApiVersion}.`,
      severity: 'critical',
    });
  }

  if (maxApiVersion < minApiVersion) {
    issues.push({
      field: 'SUPPORTED_API_VERSION_MANIFEST.maxApiVersion',
      message:
        `maxApiVersion (${maxApiVersion}) must be >= minApiVersion (${minApiVersion}). ` +
        'Update the SUPPORTED_API_VERSION_MANIFEST in config/networkReadiness.ts.',
      severity: 'critical',
    });
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run all production readiness checks and return a structured result.
 *
 * This function never throws — all failures are captured as issues.
 * The `ready` flag is false when any critical issue is present.
 * The `healthy` flag is false when any issue (critical or warning) is present.
 *
 * Optionally pass `{ skipRpcProbe: true }` to skip the live network call, e.g.
 * in unit tests that only want to exercise the config-validation layer.
 */
export async function checkNetworkReadiness(opts?: {
  skipRpcProbe?: boolean;
}): Promise<NetworkReadinessResult> {
  const startedAt = Date.now();
  const issues: ReadinessIssue[] = [];

  // 1. Network passphrase + RPC URL structural checks (no network I/O).
  const { rpcReachable: configOk } = checkNetworkPassphraseAndRpcConfig(issues);

  // 2. Live RPC probe — skipped when config is structurally invalid or caller
  //    opts out (e.g. unit tests).
  const shouldProbeRpc = configOk !== false && opts?.skipRpcProbe !== true;
  if (shouldProbeRpc) {
    await probeRpcEndpoint(issues);
  }

  // 3. Contract ID format checks.
  checkContractIds(issues);

  // 4. Asset metadata format checks.
  checkAssetMetadata(issues);

  // 5. Supported-version manifest self-consistency check.
  checkVersionManifest(issues);

  const ready = issues.every((i) => i.severity !== 'critical');
  const healthy = issues.length === 0;

  return {
    ready,
    healthy,
    issues,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Startup guard.  Run all readiness checks and terminate the process when any
 * critical issue is found, mirroring the pattern of `validateLoanConfigOnStartup`.
 *
 * - Critical issues → `process.exit(1)` with a colored terminal error.
 * - Warning issues  → logged at `warn` level; startup continues.
 * - On success      → logs a single `info` confirmation.
 *
 * Pass `{ skipRpcProbe: true }` to skip the live RPC call (useful in test-only
 * or CI-only environments where the RPC is not reachable).
 */
export async function assertNetworkReadiness(opts?: {
  skipRpcProbe?: boolean;
}): Promise<void> {
  const result = await checkNetworkReadiness(opts);

  const criticalIssues = result.issues.filter((i) => i.severity === 'critical');
  const warningIssues = result.issues.filter((i) => i.severity === 'warning');

  for (const issue of warningIssues) {
    logger.warn(`[network-readiness] ${issue.field}: ${issue.message}`);
  }

  if (criticalIssues.length === 0) {
    if (result.healthy) {
      logger.info('Network and contract configuration readiness: OK', {
        durationMs: result.durationMs,
      });
    } else {
      logger.info('Network and contract configuration readiness: DEGRADED (warnings only)', {
        durationMs: result.durationMs,
        warnings: warningIssues.length,
      });
    }
    return;
  }

  // Format a human-readable terminal error that names every broken variable
  // but never echoes their values.
  const boldRed = (msg: string) => `\x1b[1;31m${msg}\x1b[0m`;
  const bold = (msg: string) => `\x1b[1m${msg}\x1b[0m`;

  const errorPrefix = boldRed(
    'FATAL ERROR: Network and contract configuration readiness checks failed',
  );
  const lines = criticalIssues.map((i) => `  • ${bold(i.field)}: ${i.message}`);
  const actionMsg =
    'Verify the configuration variables listed above in your ' +
    '\x1b[4m.env\x1b[0m file or deployment environment before starting the service.';

  console.error(`\n${errorPrefix}\n${lines.join('\n')}\n${actionMsg}\n`);

  logger.error('Network and contract configuration readiness checks failed', {
    criticalCount: criticalIssues.length,
    warningCount: warningIssues.length,
    issues: result.issues.map((i) => ({
      field: i.field,
      severity: i.severity,
      // Truncated to avoid any risk of echoing secret fragments in a long message.
      messagePreview: i.message.slice(0, 200),
    })),
  });

  process.exit(1);
}
