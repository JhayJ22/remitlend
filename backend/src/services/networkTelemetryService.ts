import { listNetworkEndpoints, getNetworkBreaker } from '../config/networks.js';
import { sorobanWriteQueue } from './sorobanWriteQueue.js';
import {
  txSubmissionTotalCounter,
  txSubmissionDurationHistogram,
  txSubmissionThrottledCounter,
  txSubmissionErrorsCounter,
  txSubmissionInFlightGauge,
  txSubmissionCircuitStateGauge,
  sorobanWriteQueueDepthGauge,
  sorobanWriteQueueDeadLetterDepthGauge,
  sorobanWriteQueueDeadLetteredCounter,
  txSubmissionStormAlertGauge,
  txSubmissionFailoverCounter,
} from '../middleware/metrics.js';
import type { NetworkFailoverEventType } from './networkFailoverService.js';

/**
 * Per-network transaction-submission telemetry (#857).
 *
 * Records throughput, latency, throttling and error rates per configured
 * network endpoint and exposes a readable snapshot for the admin API/UI and
 * for the retry-storm alert service. The prom-client metrics are the durable
 * scrape surface; an in-memory rolling window drives instantaneous rates and
 * latency percentiles so operators get a human-readable view without querying
 * Prometheus.
 *
 * Label cardinality is bounded: the `network` label is the endpoint id, drawn
 * from the small configured registry, so this never explodes label space.
 */

export type SubmissionOutcome =
  | 'submitted'
  | 'queued'
  | 'failed'
  | 'throttled'
  | 'duplicate'
  | 'dead_lettered';

export type SubmissionErrorClass = 'transient' | 'rejected' | 'poll_error' | 'no_endpoint';

interface NetworkWindow {
  attempts: number[];
  errors: number[];
  throttles: number[];
  latencies: number[];
  inFlight: number;
}

const WINDOW_DEFAULT_MS = 60_000;
const MAX_LATENCY_SAMPLES = 200;

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function windowMs(): number {
  return readPositiveInt('TX_SUBMISSION_STORM_WINDOW_MS', WINDOW_DEFAULT_MS);
}

const windows = new Map<string, NetworkWindow>();

function windowFor(networkId: string): NetworkWindow {
  let w = windows.get(networkId);
  if (!w) {
    w = { attempts: [], errors: [], throttles: [], latencies: [], inFlight: 0 };
    windows.set(networkId, w);
  }
  return w;
}

function prune(ts: number[], now: number, window: number): number[] {
  const cutoff = now - window;
  let i = 0;
  while (i < ts.length && ts[i]! < cutoff) i += 1;
  return i > 0 ? ts.slice(i) : ts;
}

function percentile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

function safeRate(num: number, denom: number): number {
  return denom > 0 ? num / denom : 0;
}

// ── Recording API ──────────────────────────────────────────────────────────

export function recordSubmissionAttempt(networkId: string): void {
  const w = windowFor(networkId);
  const now = Date.now();
  w.attempts = prune(w.attempts, now, windowMs());
  w.attempts.push(now);
  txSubmissionTotalCounter.inc({ network: networkId, outcome: 'submitted' });
}

export function recordSubmissionOutcome(
  networkId: string,
  outcome: SubmissionOutcome,
  durationMs: number | null,
): void {
  if (outcome !== 'submitted') {
    txSubmissionTotalCounter.inc({ network: networkId, outcome });
  }
  if (durationMs !== null && durationMs >= 0) {
    txSubmissionDurationHistogram.observe({ network: networkId }, durationMs / 1000);
    const w = windowFor(networkId);
    w.latencies.push(durationMs);
    if (w.latencies.length > MAX_LATENCY_SAMPLES) w.latencies.shift();
  }
}

export function recordSubmissionThrottle(networkId: string): void {
  const w = windowFor(networkId);
  const now = Date.now();
  w.throttles = prune(w.throttles, now, windowMs());
  w.throttles.push(now);
  txSubmissionThrottledCounter.inc({ network: networkId });
}

export function recordSubmissionError(networkId: string, errorClass: SubmissionErrorClass): void {
  const w = windowFor(networkId);
  const now = Date.now();
  w.errors = prune(w.errors, now, windowMs());
  w.errors.push(now);
  txSubmissionErrorsCounter.inc({ network: networkId, error_class: errorClass });
}

export function incSubmissionInFlight(networkId: string): void {
  const w = windowFor(networkId);
  w.inFlight += 1;
  txSubmissionInFlightGauge.set({ network: networkId }, w.inFlight);
}

export function decSubmissionInFlight(networkId: string): void {
  const w = windowFor(networkId);
  w.inFlight = Math.max(0, w.inFlight - 1);
  txSubmissionInFlightGauge.set({ network: networkId }, w.inFlight);
}

export function setNetworkCircuitState(networkId: string, value: 0 | 1 | 2): void {
  txSubmissionCircuitStateGauge.set({ network: networkId }, value);
}

export function recordFailoverMetric(eventType: NetworkFailoverEventType): void {
  txSubmissionFailoverCounter.inc({ event_type: eventType });
}

export function recordDeadLetter(): void {
  sorobanWriteQueueDeadLetteredCounter.inc();
  void refreshWriteQueueGauges();
}

export function setStormAlertActive(active: boolean): void {
  txSubmissionStormAlertGauge.set(active ? 1 : 0);
}

// ── Snapshot API ─────────────────────────────────────────────────────────────

export interface NetworkTelemetrySummary {
  networkId: string;
  throughputPerSec: number;
  attemptCount: number;
  errorRate: number;
  throttleRate: number;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  latencyP99Ms: number | null;
  inFlight: number;
}

export interface NetworkTelemetrySnapshot {
  windowMs: number;
  generatedAt: number;
  networks: NetworkTelemetrySummary[];
  writeQueue: {
    pending: number;
    deadLettered: number;
  };
  stormAlertActive: boolean;
}

export async function getNetworkTelemetrySnapshot(): Promise<NetworkTelemetrySnapshot> {
  const window = windowMs();
  const now = Date.now();

  const networks = listNetworkEndpoints().map((endpoint) => {
    const w = windowFor(endpoint.id);
    const attempts = prune(w.attempts, now, window);
    const errors = prune(w.errors, now, window);
    const throttles = prune(w.throttles, now, window);
    const sorted = [...w.latencies].sort((a, b) => a - b);
    const seconds = window / 1000;

    return {
      networkId: endpoint.id,
      throughputPerSec: attempts.length / seconds,
      attemptCount: attempts.length,
      errorRate: safeRate(errors.length, attempts.length),
      throttleRate: safeRate(throttles.length, attempts.length),
      latencyP50Ms: percentile(sorted, 0.5),
      latencyP95Ms: percentile(sorted, 0.95),
      latencyP99Ms: percentile(sorted, 0.99),
      inFlight: w.inFlight,
    };
  });

  const [pending, deadLettered] = await Promise.all([
    sorobanWriteQueue.pendingCount().catch(() => 0),
    sorobanWriteQueue.deadLetterCount().catch(() => 0),
  ]);

  // Keep the Prometheus scrape surface fresh for any reader (admin UI poll or
  // the replay loop both flow through this snapshot).
  sorobanWriteQueueDepthGauge.set(pending);
  sorobanWriteQueueDeadLetterDepthGauge.set(deadLettered);
  exportCircuitStateGauges();

  return {
    windowMs: window,
    generatedAt: now,
    networks,
    writeQueue: { pending, deadLettered },
    stormAlertActive: stormAlertActive,
  };
}

let stormAlertActive = false;

export function isStormAlertActive(): boolean {
  return stormAlertActive;
}

export function setStormAlertState(active: boolean): boolean {
  const changed = stormAlertActive !== active;
  stormAlertActive = active;
  if (changed) setStormAlertActive(active);
  return changed;
}

/** Refresh the durable write-queue depth + dead-letter gauges from the DB. */
export async function refreshWriteQueueGauges(): Promise<void> {
  try {
    const [pending, deadLettered] = await Promise.all([
      sorobanWriteQueue.pendingCount(),
      sorobanWriteQueue.deadLetterCount(),
    ]);
    sorobanWriteQueueDepthGauge.set(pending);
    sorobanWriteQueueDeadLetterDepthGauge.set(deadLettered);
  } catch {
    // Best-effort; a transient DB error must not break the metrics refresh.
  }
}

/** Export per-network circuit-state gauges for all configured endpoints. */
export function exportCircuitStateGauges(): void {
  for (const endpoint of listNetworkEndpoints()) {
    const state = getNetworkBreaker(endpoint.id).getStatus().state;
    const value: 0 | 1 | 2 = state === 'open' ? 2 : state === 'half-open' ? 1 : 0;
    setNetworkCircuitState(endpoint.id, value);
  }
}
