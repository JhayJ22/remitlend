import { type rpc } from '@stellar/stellar-sdk';
import logger from '../utils/logger.js';
import { query } from '../db/connection.js';
import {
  getNetworkBreaker,
  getNetworkEndpoint,
  getNetworkServer,
  listNetworkEndpoints,
  getActiveNetworkEndpointId,
  setActiveNetworkEndpointId,
  getMaxFailoverHops,
  type NetworkEndpoint,
} from '../config/networks.js';
import type { SorobanCircuitState } from './sorobanCircuitBreaker.js';

/**
 * Bounded network failover for transaction submission (#857).
 *
 * On every submission this service selects a healthy RPC endpoint in
 * submission-priority order, bounded by `TX_SUBMISSION_MAX_FAILOVER_HOPS`.
 * The primary endpoint (priority 0) is always considered first, which gives
 * automatic failback once it recovers. Failover only ever routes to endpoints
 * that share the primary network passphrase (enforced by the registry), so the
 * signed, immutable transaction is relayed unchanged — its hash and on-chain
 * effect are identical regardless of which node relays it.
 *
 * When no endpoint within the hop bound is healthy the service throws
 * {@link NoHealthyEndpointError}; the caller persists the signed transaction to
 * the durable write queue (never lost) and the replay processor drains it
 * once an endpoint recovers. Retries on the queue are themselves bounded by a
 * max-attempts/dead-letter policy, so the system cannot retry-storm forever.
 */

export class NoHealthyEndpointError extends Error {
  constructor(reason: string) {
    super(`No healthy transaction-submission endpoint available: ${reason}`);
    this.name = 'NoHealthyEndpointError';
  }
}

export interface SelectedEndpoint {
  endpointId: string;
  server: rpc.Server;
}

export type NetworkFailoverEventType =
  | 'failover_activated'
  | 'failover_deactivated'
  | 'failover_exhausted'
  | 'retry_storm_alert'
  | 'retry_storm_recovered';

export interface NetworkFailoverEvent {
  id: number;
  networkId: string;
  fromNetworkId: string | null;
  eventType: NetworkFailoverEventType;
  details: Record<string, unknown>;
  createdAt: string;
}

interface FailoverEventRow {
  id: number;
  network_id: string;
  from_network_id: string | null;
  event_type: string;
  details: Record<string, unknown>;
  created_at: Date | string;
}

function toEvent(row: FailoverEventRow): NetworkFailoverEvent {
  return {
    id: row.id,
    networkId: row.network_id,
    fromNetworkId: row.from_network_id,
    eventType: row.event_type as NetworkFailoverEventType,
    details: row.details ?? {},
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/**
 * Selects a healthy endpoint for the next submission, failing over within the
 * bounded hop set. Returns the endpoint id + its `rpc.Server`. Throws
 * {@link NoHealthyEndpointError} when no endpoint in the hop bound is healthy.
 */
export function selectEndpointForSubmission(): SelectedEndpoint {
  const hops = getMaxFailoverHops();
  const ordered = listNetworkEndpoints().filter((e) => e.enabled).slice(0, Math.max(1, hops));
  const previousActive = getActiveNetworkEndpointId();

  for (const endpoint of ordered) {
    const breaker = getNetworkBreaker(endpoint.id);
    // shouldShortCircuit() is the cheap in-memory gate (no network probe) used
    // by the existing degradation path. It returns false when the breaker is
    // closed, or half-open with a trial call still available.
    if (!breaker.shouldShortCircuit()) {
      if (endpoint.id !== previousActive) {
        recordFailoverTransition(previousActive, endpoint.id, 'primary unhealthy');
      }
      return { endpointId: endpoint.id, server: getNetworkServer(endpoint.id) };
    }
  }

  throw new NoHealthyEndpointError(
    `all ${ordered.length} considered endpoint(s) short-circuiting`,
  );
}

/**
 * Records a submission failure against an endpoint's breaker. Does not switch
 * the active endpoint here — the next {@link selectEndpointForSubmission} call
 * performs the (bounded) switch if needed, which keeps failover decisions
 * co-located and testable.
 */
export function recordEndpointFailure(endpointId: string, error: unknown): void {
  const endpoint = getNetworkEndpoint(endpointId);
  if (!endpoint) return;
  getNetworkBreaker(endpointId).recordFailure(error);
}

/** Records a submission success, closing the endpoint's breaker. */
export function recordEndpointSuccess(endpointId: string): void {
  const endpoint = getNetworkEndpoint(endpointId);
  if (!endpoint) return;
  getNetworkBreaker(endpointId).recordSuccess();
}

function recordFailoverTransition(fromId: string, toId: string, reason: string): void {
  setActiveNetworkEndpointId(toId);
  const eventType: NetworkFailoverEventType =
    toId === listNetworkEndpoints()[0]!.id ? 'failover_deactivated' : 'failover_activated';
  logger
    .withContext({ module: 'network-failover' })
    .warn('Transaction submission failover', { from: fromId, to: toId, reason, eventType });
  void recordFailoverEvent({ toId, fromId, eventType, details: { reason } });
}

/** Records an endpoint-exhaustion event (no healthy endpoint in the hop bound). */
export function recordFailoverExhausted(reason: string): void {
  void recordFailoverEvent({
    toId: getActiveNetworkEndpointId(),
    fromId: null,
    eventType: 'failover_exhausted',
    details: { reason },
  });
}

interface RecordEventInput {
  toId: string;
  fromId: string | null;
  eventType: NetworkFailoverEventType;
  details: Record<string, unknown>;
}

/**
 * Persists a failover/alert event. Best-effort: a DB failure never blocks the
 * submission path — the event is logged regardless so operators retain
 * visibility even if the audit table is momentarily unavailable.
 */
export async function recordFailoverEvent(input: RecordEventInput): Promise<void> {
  try {
    await query(
      `INSERT INTO network_failover_events (network_id, from_network_id, event_type, details)
       VALUES ($1, $2, $3, $4)`,
      [input.toId, input.fromId, input.eventType, JSON.stringify(input.details ?? {})],
    );
  } catch (error) {
    logger
      .withContext({ module: 'network-failover' })
      .warn('Failed to persist network failover event', {
        eventType: input.eventType,
        toId: input.toId,
        error: error instanceof Error ? error.message : String(error),
      });
  }
}

/** Recent failover/alert events for the admin UI (newest first). */
export async function listNetworkFailoverEvents(limit = 50): Promise<NetworkFailoverEvent[]> {
  const safeLimit = Math.min(Math.max(limit, 1), 200);
  const result = await query(
    `SELECT id, network_id, from_network_id, event_type, details, created_at
     FROM network_failover_events
     ORDER BY id DESC
     LIMIT $1`,
    [safeLimit],
  );
  return (result.rows as FailoverEventRow[]).map(toEvent);
}

export interface NetworkEndpointStatus {
  id: string;
  label: string;
  rpcUrl: string;
  priority: number;
  enabled: boolean;
  active: boolean;
  circuitState: SorobanCircuitState;
  consecutiveFailures: number;
  lastError: string | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
}

export interface NetworkFailoverSnapshot {
  activeEndpointId: string;
  maxFailoverHops: number;
  endpoints: NetworkEndpointStatus[];
}

/** A consistent status snapshot of every endpoint + the active selection. */
export function getNetworkFailoverStatus(): NetworkFailoverSnapshot {
  const active = getActiveNetworkEndpointId();
  const endpoints = listNetworkEndpoints().map((endpoint: NetworkEndpoint) => {
    const status = getNetworkBreaker(endpoint.id).getStatus();
    return {
      id: endpoint.id,
      label: endpoint.label,
      rpcUrl: endpoint.rpcUrl,
      priority: endpoint.priority,
      enabled: endpoint.enabled,
      active: endpoint.id === active,
      circuitState: status.state,
      consecutiveFailures: status.consecutiveFailures,
      lastError: status.lastError,
      lastSuccessAt: status.lastSuccessAt,
      lastFailureAt: status.lastFailureAt,
    };
  });

  return {
    activeEndpointId: active,
    maxFailoverHops: getMaxFailoverHops(),
    endpoints,
  };
}
