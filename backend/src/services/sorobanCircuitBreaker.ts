import logger from '../utils/logger.js';
import { createSorobanRpcServer } from '../config/stellar.js';

export type SorobanCircuitState = 'closed' | 'open' | 'half-open';

export interface SorobanAvailability {
  available: boolean;
  latestLedger?: number;
  error?: string;
  checkedAt: number;
}

export interface SorobanCircuitSnapshot<T = unknown> {
  value: T;
  storedAt: number;
}

export interface SorobanDegradationStatus {
  state: SorobanCircuitState;
  available: boolean;
  degraded: boolean;
  consecutiveFailures: number;
  lastCheckedAt: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastError: string | null;
  lastStaleServedAt: number | null;
  warning: string | null;
}

export const SOROBAN_DEGRADATION_WARNING =
  'Stellar RPC is currently unavailable. Serving the last known on-chain data; ' +
  'write operations are queued and will be replayed automatically.';

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Raised when a guarded RPC call is rejected because the circuit is open.
 */
export class SorobanCircuitOpenError extends Error {
  constructor(context: string) {
    super(`Soroban RPC circuit is open; refusing "${context}"`);
    this.name = 'SorobanCircuitOpenError';
  }
}

/**
 * Cached availability probe, circuit breaker and stale-read snapshot store for
 * the Soroban RPC dependency (issue #74).
 *
 * The Soroban RPC endpoint is an external hard dependency. Rather than letting
 * every read/write fail hard when it is unreachable, this breaker:
 *   - probes RPC health with a short timeout and caches the status so burst
 *     traffic does not fan out to the RPC,
 *   - opens after N consecutive failures and half-opens after a cooldown,
 *   - keeps the last known-good value for read paths so they can serve stale
 *     data with a warning while the RPC is down.
 *
 * All thresholds are env-overridable and default to safe values so no new
 * configuration is required to deploy.
 */
export class SorobanCircuitBreaker {
  private state: SorobanCircuitState = 'closed';
  private consecutiveFailures = 0;
  private openedAt = 0;
  private halfOpenInFlight = false;
  private lastSuccessAt: number | null = null;
  private lastFailureAt: number | null = null;
  private lastError: string | null = null;
  private lastStaleServedAt: number | null = null;
  private cachedAvailability: SorobanAvailability | null = null;
  private probeInFlight: Promise<SorobanAvailability> | null = null;
  private readonly snapshots = new Map<string, SorobanCircuitSnapshot>();

  private get healthTimeoutMs(): number {
    return readPositiveInt('SOROBAN_RPC_HEALTH_TIMEOUT_MS', 1500);
  }

  private get healthCacheMs(): number {
    return readPositiveInt('SOROBAN_RPC_HEALTH_CACHE_MS', 3000);
  }

  private get failureThreshold(): number {
    return readPositiveInt('SOROBAN_CIRCUIT_FAILURE_THRESHOLD', 3);
  }

  private get cooldownMs(): number {
    return readPositiveInt('SOROBAN_CIRCUIT_COOLDOWN_MS', 15000);
  }

  private get staleReadTtlMs(): number {
    return readPositiveInt('SOROBAN_STALE_READ_TTL_MS', 3600000);
  }

  private get staleWarningTtlMs(): number {
    return readPositiveInt('SOROBAN_STALE_WARNING_TTL_MS', 60000);
  }

  /**
   * Probe RPC availability with a short timeout, reusing a cached result for
   * `SOROBAN_RPC_HEALTH_CACHE_MS`. Pass `force` to bypass the cache (used by
   * tests and by explicit operator health checks).
   */
  async checkAvailability(force = false): Promise<SorobanAvailability> {
    const now = Date.now();

    if (
      !force &&
      this.cachedAvailability &&
      now - this.cachedAvailability.checkedAt < this.healthCacheMs
    ) {
      return this.cachedAvailability;
    }

    if (!force && !this.probeInFlight && this.shouldShortCircuit()) {
      return (
        this.cachedAvailability ?? {
          available: false,
          error: this.lastError ?? 'Soroban RPC circuit is open',
          checkedAt: now,
        }
      );
    }

    if (this.probeInFlight) {
      return this.probeInFlight;
    }

    const probe = this.runProbe().finally(() => {
      this.probeInFlight = null;
    });
    this.probeInFlight = probe;
    return probe;
  }

  private async runProbe(): Promise<SorobanAvailability> {
    try {
      const latestLedger = await this.withTimeout(this.readLatestLedger(), this.healthTimeoutMs);
      this.recordSuccess();

      const availability: SorobanAvailability =
        latestLedger !== undefined
          ? { available: true, latestLedger, checkedAt: Date.now() }
          : { available: true, checkedAt: Date.now() };
      this.cachedAvailability = availability;
      return availability;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!(error instanceof SorobanCircuitOpenError)) {
        this.recordFailure(error);
      }

      const availability: SorobanAvailability = {
        available: false,
        error: message,
        checkedAt: Date.now(),
      };
      this.cachedAvailability = availability;
      return availability;
    }
  }

  private async readLatestLedger(): Promise<number | undefined> {
    const response = await createSorobanRpcServer().getLatestLedger();
    return response.sequence;
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Stellar RPC health probe timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref();

      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  /**
   * True when callers should be rejected without touching the RPC. When the
   * cooldown has elapsed the circuit half-opens and one trial call is allowed.
   */
  shouldShortCircuit(): boolean {
    const now = Date.now();

    if (this.state === 'open') {
      if (now - this.openedAt < this.cooldownMs) {
        return true;
      }
      this.state = 'half-open';
      this.halfOpenInFlight = false;
      logger.withContext().warn('Soroban RPC circuit half-open; allowing one recovery attempt');
    }

    if (this.state === 'half-open') {
      if (this.halfOpenInFlight) {
        return true;
      }
      this.halfOpenInFlight = true;
      return false;
    }

    return false;
  }

  recordSuccess(): void {
    const wasDegraded = this.state !== 'closed';
    this.state = 'closed';
    this.consecutiveFailures = 0;
    this.halfOpenInFlight = false;
    this.lastSuccessAt = Date.now();
    this.lastError = null;

    if (wasDegraded) {
      logger.withContext().info('Soroban RPC circuit closed after successful call');
    }
  }

  recordFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.lastError = message;
    this.lastFailureAt = Date.now();
    this.halfOpenInFlight = false;
    this.consecutiveFailures += 1;

    const shouldOpen =
      this.state === 'half-open' || this.consecutiveFailures >= this.failureThreshold;

    if (shouldOpen && this.state !== 'open') {
      this.state = 'open';
      this.openedAt = Date.now();
      logger.withContext().error('Soroban RPC circuit opened after repeated failures', {
        consecutiveFailures: this.consecutiveFailures,
        error: message,
      });
    }
  }

  recordStaleServed(): void {
    this.lastStaleServedAt = Date.now();
  }

  saveSnapshot<T>(key: string, value: T): void {
    this.snapshots.set(key, { value, storedAt: Date.now() });
  }

  readSnapshot<T>(key: string): SorobanCircuitSnapshot<T> | null {
    const entry = this.snapshots.get(key);
    if (!entry) {
      return null;
    }

    if (Date.now() - entry.storedAt > this.staleReadTtlMs) {
      this.snapshots.delete(key);
      return null;
    }

    return entry as SorobanCircuitSnapshot<T>;
  }

  isOpen(): boolean {
    return this.state === 'open';
  }

  isHalfOpen(): boolean {
    return this.state === 'half-open';
  }

  getStatus(): SorobanDegradationStatus {
    const now = Date.now();
    const recentlyServedStale =
      this.lastStaleServedAt !== null && now - this.lastStaleServedAt < this.staleWarningTtlMs;
    const degraded = this.state !== 'closed' || recentlyServedStale;

    return {
      state: this.state,
      available: this.cachedAvailability?.available ?? this.state === 'closed',
      degraded,
      consecutiveFailures: this.consecutiveFailures,
      lastCheckedAt: this.cachedAvailability?.checkedAt ?? null,
      lastSuccessAt: this.lastSuccessAt,
      lastFailureAt: this.lastFailureAt,
      lastError: this.lastError,
      lastStaleServedAt: this.lastStaleServedAt,
      warning: degraded ? SOROBAN_DEGRADATION_WARNING : null,
    };
  }

  /** Reset all cached state. Used by tests and on a clean process restart. */
  reset(): void {
    this.state = 'closed';
    this.consecutiveFailures = 0;
    this.openedAt = 0;
    this.halfOpenInFlight = false;
    this.lastSuccessAt = null;
    this.lastFailureAt = null;
    this.lastError = null;
    this.lastStaleServedAt = null;
    this.cachedAvailability = null;
    this.probeInFlight = null;
    this.snapshots.clear();
  }
}

export const sorobanCircuitBreaker = new SorobanCircuitBreaker();
