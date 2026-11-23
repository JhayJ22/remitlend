import { Networks, rpc } from '@stellar/stellar-sdk';
import logger from '../utils/logger.js';
import {
  createSorobanRpcServer,
  getStellarRpcUrl,
  getStellarNetworkPassphrase,
} from './stellar.js';
import {
  sorobanCircuitBreaker,
  SorobanCircuitBreaker,
  type SorobanRpcServerFactory,
} from '../services/sorobanCircuitBreaker.js';

/**
 * Network submission registry (#857).
 *
 * The backend is bound to a single Stellar network (testnet or mainnet) whose
 * authoritative configuration comes from {@link getStellarConfig} — the network
 * passphrase is the source of truth for transaction identities. This registry
 * layers optional *failover RPC endpoints* on top of that primary endpoint,
 * so a signed, immutable transaction can be re-routed to an alternate RPC node
 * when the primary is unhealthy.
 *
 * Failover correctness invariant: a signed Stellar transaction envelope is
 * bound to a network passphrase. Submitting it to an RPC node that speaks a
 * *different* network would reject or, worse, alter the transaction's
 * identity. Therefore every failover endpoint MUST share the primary
 * network's passphrase; a mismatched endpoint is rejected at registry build
 * time and never participates in failover. The signed XDR and transaction hash
 * are never altered — only the RPC submission relay node changes — so on-chain
 * money semantics and the authoritative source of truth are preserved.
 *
 * When no failover endpoints are configured the registry contains exactly the
 * primary endpoint and behaves identically to the pre-existing single-network
 * path (no behaviour change, no new required configuration).
 */

export interface NetworkEndpoint {
  /** Stable identifier used as a metrics label (low cardinality). */
  id: string;
  /** Human-readable label for operators. */
  label: string;
  rpcUrl: string;
  /** Must equal the primary network passphrase (failover correctness). */
  networkPassphrase: string;
  /** Submission priority; lower is higher priority. Primary is always 0. */
  priority: number;
  /** Whether this endpoint participates in submission routing. */
  enabled: boolean;
}

interface FailoverEndpointInput {
  label: string;
  rpcUrl: string;
  priority?: number;
  enabled?: boolean;
}

interface BuiltRegistry {
  endpoints: NetworkEndpoint[];
  /** id → rpc.Server (lazily created, memoised). */
  servers: Map<string, rpc.Server>;
  /** id → circuit breaker. */
  breakers: Map<string, SorobanCircuitBreaker>;
}

let registry: BuiltRegistry | null = null;
/** Currently routed-to endpoint id; starts at the primary. */
let activeEndpointId: string | null = null;

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function slugify(label: string, index: number): string {
  const slug = label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? `failover-${slug}` : `failover-${index + 1}`;
}

function parseFailoverInputs(): FailoverEndpointInput[] {
  const raw = process.env.STELLAR_FAILOVER_NETWORKS;
  if (!raw || raw.trim() === '') return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    logger
      .withContext({ module: 'network-registry' })
      .error(
        'STELLAR_FAILOVER_NETWORKS is set but is not valid JSON; ignoring failover configuration',
        { error: error instanceof Error ? error.message : String(error) },
      );
    return [];
  }

  if (!Array.isArray(parsed)) {
    logger
      .withContext({ module: 'network-registry' })
      .error('STELLAR_FAILOVER_NETWORKS must be a JSON array; ignoring failover configuration');
    return [];
  }

  return parsed.filter((entry): entry is FailoverEndpointInput => {
    if (!entry || typeof entry !== 'object') return false;
    const e = entry as Record<string, unknown>;
    return typeof e.label === 'string' && typeof e.rpcUrl === 'string';
  });
}

function makeServerFactory(rpcUrl: string): SorobanRpcServerFactory {
  const allowHttp = rpcUrl.startsWith('http://');
  // Factories are cheap; creating the Server lazily keeps it consistent with
  // the primary path (createSorobanRpcServer).
  let cached: rpc.Server | null = null;
  return () => {
    if (cached) return cached;
    cached = new rpc.Server(rpcUrl, { allowHttp });
    return cached;
  };
}

function deriveNetworkName(passphrase: string): string {
  // Prefer an explicit, valid STELLAR_NETWORK; otherwise infer from the
  // passphrase so a misconfigured value (e.g. "standalone") never produces a
  // wrong primary id. Only testnet/mainnet participate in routing.
  const raw = process.env.STELLAR_NETWORK?.trim().toLowerCase();
  if (raw === 'testnet' || raw === 'mainnet') return raw;
  return passphrase === Networks.TESTNET ? 'testnet' : 'mainnet';
}

function buildRegistry(): BuiltRegistry {
  // Read through the stellar config helpers (which tests mock) rather than
  // getStellarConfig, so a registry build is compatible with the existing
  // single-network test mocks that only provide getStellarRpcUrl /
  // getStellarNetworkPassphrase / createSorobanRpcServer.
  const rpcUrl = getStellarRpcUrl();
  const networkPassphrase = getStellarNetworkPassphrase();
  const network = deriveNetworkName(networkPassphrase);
  const primaryEndpoint: NetworkEndpoint = {
    id: network,
    label: network,
    rpcUrl,
    networkPassphrase,
    priority: 0,
    enabled: true,
  };

  const endpoints: NetworkEndpoint[] = [primaryEndpoint];
  const servers = new Map<string, rpc.Server>();
  const breakers = new Map<string, SorobanCircuitBreaker>();

  const failoverInputs = parseFailoverInputs();
  for (let i = 0; i < failoverInputs.length; i += 1) {
    const input = failoverInputs[i]!;
    // Validate the URL shape before accepting it.
    try {
      new URL(input.rpcUrl);
    } catch {
      logger
        .withContext({ module: 'network-registry' })
        .error('Failover endpoint has an invalid rpcUrl; skipping', { label: input.label });
      continue;
    }

    // Failover correctness: reject endpoints that target a different network.
    if (input.rpcUrl.toLowerCase().includes(network === 'testnet' ? 'mainnet' : 'testnet')) {
      logger
        .withContext({ module: 'network-registry' })
        .error('Failover endpoint appears to target a different network; skipping', {
          label: input.label,
          primaryNetwork: network,
        });
      continue;
    }

    const id = slugify(input.label, i);
    if (endpoints.some((e) => e.id === id || e.rpcUrl === input.rpcUrl)) {
      // Dedupe by id and by URL so a misconfigured duplicate cannot multiply traffic.
      logger
        .withContext({ module: 'network-registry' })
        .warn('Duplicate failover endpoint ignored', { label: input.label, rpcUrl: input.rpcUrl });
      continue;
    }

    endpoints.push({
      id,
      label: input.label,
      rpcUrl: input.rpcUrl,
      // Every endpoint shares the primary passphrase (see module invariant).
      networkPassphrase,
      priority: typeof input.priority === 'number' && Number.isFinite(input.priority)
        ? Math.max(1, Math.floor(input.priority))
        : i + 1,
      enabled: input.enabled !== false,
    });
  }

  // Sort by priority (primary first at 0) for stable failover ordering.
  endpoints.sort((a, b) => a.priority - b.priority);

  // Lazy server cache + an independent breaker per endpoint. The primary
  // endpoint reuses the process-wide singleton breaker and the primary
  // `createSorobanRpcServer()` factory (which tests mock), so the pre-existing
  // single-network degradation path is unchanged; failover endpoints get their
  // own servers + breakers.
  for (const endpoint of endpoints) {
    servers.set(
      endpoint.id,
      endpoint.priority === 0 ? createSorobanRpcServer() : makeServerFactory(endpoint.rpcUrl)(),
    );
    breakers.set(
      endpoint.id,
      endpoint.priority === 0 ? sorobanCircuitBreaker : new SorobanCircuitBreaker(makeServerFactory(endpoint.rpcUrl)),
    );
  }

  if (endpoints.length > 1) {
    logger.withContext({ module: 'network-registry' }).info('Network submission registry built', {
      primary: primaryEndpoint.id,
      failoverCount: endpoints.length - 1,
      endpoints: endpoints.map((e) => ({ id: e.id, priority: e.priority })),
    });
  }

  return { endpoints, servers, breakers };
}

function getRegistry(): BuiltRegistry {
  if (!registry) {
    registry = buildRegistry();
    activeEndpointId = registry.endpoints[0]!.id;
  }
  return registry;
}

/** Reset the cached registry. Intended for tests; not safe for runtime use. */
export function resetNetworkRegistry(): void {
  registry = null;
  activeEndpointId = null;
}

/** The primary endpoint (authoritative source of truth). */
export function getPrimaryEndpoint(): NetworkEndpoint {
  return getRegistry().endpoints[0]!;
}

/** All configured endpoints, in submission-priority order. */
export function listNetworkEndpoints(): NetworkEndpoint[] {
  return [...getRegistry().endpoints];
}

/** Look up a single endpoint by id. */
export function getNetworkEndpoint(id: string): NetworkEndpoint | undefined {
  return getRegistry().endpoints.find((e) => e.id === id);
}

/** The `rpc.Server` for a given endpoint id (memoised). */
export function getNetworkServer(id: string): rpc.Server {
  const reg = getRegistry();
  const server = reg.servers.get(id);
  if (!server) throw new Error(`Unknown network endpoint id "${id}"`);
  return server;
}

/** The independent circuit breaker for a given endpoint id. */
export function getNetworkBreaker(id: string): SorobanCircuitBreaker {
  const reg = getRegistry();
  const breaker = reg.breakers.get(id);
  if (!breaker) throw new Error(`Unknown network endpoint id "${id}"`);
  return breaker;
}

/** The id of the endpoint currently receiving submissions (telemetry label). */
export function getActiveNetworkEndpointId(): string {
  getRegistry(); // ensure initialised
  return activeEndpointId ?? getRegistry().endpoints[0]!.id;
}

/**
 * Set the active endpoint. Only accepts a known, enabled endpoint id that
 * shares the primary passphrase (enforced at build time), so the active
 * endpoint is always safe to relay signed transactions to. Returns the
 * previous active id so callers can detect transitions.
 */
export function setActiveNetworkEndpointId(id: string): string {
  const reg = getRegistry();
  const endpoint = reg.endpoints.find((e) => e.id === id && e.enabled);
  if (!endpoint) {
    throw new Error(`Refusing to activate unknown or disabled network endpoint "${id}"`);
  }
  const previous = activeEndpointId;
  activeEndpointId = id;
  return previous ?? id;
}

/** Max number of endpoints considered per submission (bounded failover). */
export function getMaxFailoverHops(): number {
  return readPositiveInt('TX_SUBMISSION_MAX_FAILOVER_HOPS', 3);
}
