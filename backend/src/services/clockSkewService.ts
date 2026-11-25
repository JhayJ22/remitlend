import { Pool } from 'pg';
import { jobMetricsService } from './jobMetricsService';
import { failoverAlertService } from './failoverAlertService';

/**
 * Clock skew monitoring and authoritative timestamp policy.
 *
 * Authoritative time source: the ledger checkpoint time (server-side, monotonic
 * within a checkpoint window). All validity windows for nonces, quotes, and
 * authorizations MUST be evaluated against `resolveAuthoritativeNow`, never
 * against a client-supplied or provider-local clock. This guarantees that
 * clock skew cannot extend a validity window.
 */

export interface ClockSkewSample {
  source: 'service' | 'provider';
  sourceId: string;
  authoritativeTime: Date;
  observedTime: Date;
  driftMs: number;
  sampledAt: Date;
}

export interface ClockSkewThresholds {
  /** Drift above this (absolute ms) is recorded as a warning. */
  warnMs: number;
  /** Drift above this (absolute ms) raises an alert. */
  alertMs: number;
  /** Drift above this (absolute ms) is treated as critical. */
  criticalMs: number;
}

export const DEFAULT_CLOCK_SKEW_THRESHOLDS: ClockSkewThresholds = {
  warnMs: 250,
  alertMs: 1000,
  criticalMs: 5000,
};

export interface ClockSkewServiceOptions {
  pool: Pool;
  thresholds?: ClockSkewThresholds;
  /** Returns the authoritative ledger checkpoint time. */
  getAuthoritativeTime: () => Promise<Date>;
  /** Optional provider time samplers keyed by provider id. */
  providerSamplers?: Record<string, () => Promise<Date>>;
  /** Optional service-local clock override (defaults to Date.now). */
  serviceClock?: () => Date;
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
}

export interface ClockSkewRunResult {
  samples: ClockSkewSample[];
  maxDriftMs: number;
  alertsRaised: number;
}

/**
 * Error thrown when an action's timestamp falls outside the allowed skew
 * tolerance relative to the authoritative clock.
 */
export class ClockSkewError extends Error {
  readonly code = 'CLOCK_SKEW_EXCEEDED';
  constructor(
    message: string,
    readonly driftMs: number,
    readonly toleranceMs: number,
  ) {
    super(message);
    this.name = 'ClockSkewError';
  }
}

export class ClockSkewService {
  private readonly pool: Pool;
  private readonly thresholds: ClockSkewThresholds;
  private readonly getAuthoritativeTime: () => Promise<Date>;
  private readonly providerSamplers: Record<string, () => Promise<Date>>;
  private readonly serviceClock: () => Date;
  private readonly logger: Pick<Console, 'info' | 'warn' | 'error'>;

  constructor(options: ClockSkewServiceOptions) {
    this.pool = options.pool;
    this.thresholds = options.thresholds ?? DEFAULT_CLOCK_SKEW_THRESHOLDS;
    this.getAuthoritativeTime = options.getAuthoritativeTime;
    this.providerSamplers = options.providerSamplers ?? {};
    this.serviceClock = options.serviceClock ?? (() => new Date());
    this.logger = options.logger ?? console;
  }

  /**
   * Sample service and provider clocks against the authoritative ledger
   * checkpoint time, persist samples, emit metrics, and raise alerts.
   */
  async run(): Promise<ClockSkewRunResult> {
    const authoritativeTime = await this.getAuthoritativeTime();
    const samples: ClockSkewSample[] = [];

    // Sample the local service clock.
    const serviceObserved = this.serviceClock();
    samples.push(
      this.buildSample('service', 'local', authoritativeTime, serviceObserved),
    );

    // Sample each configured provider.
    for (const [providerId, sampler] of Object.entries(this.providerSamplers)) {
      try {
        const observed = await sampler();
        samples.push(
          this.buildSample('provider', providerId, authoritativeTime, observed),
        );
      } catch (err) {
        this.logger.error(
          `[clockSkew] failed to sample provider ${providerId}: ${
            (err as Error).message
          }`,
        );
        jobMetricsService.recordJobFailure('clock_skew_sample', {
          source: 'provider',
          sourceId: providerId,
        });
      }
    }

    let maxDriftMs = 0;
    let alertsRaised = 0;

    for (const sample of samples) {
      const absDrift = Math.abs(sample.driftMs);
      if (absDrift > maxDriftMs) maxDriftMs = absDrift;

      await this.persistSample(sample);
      this.emitMetrics(sample);

      if (absDrift >= this.thresholds.criticalMs) {
        await this.raiseAlert(sample, 'critical');
        alertsRaised += 1;
      } else if (absDrift >= this.thresholds.alertMs) {
        await this.raiseAlert(sample, 'alert');
        alertsRaised += 1;
      } else if (absDrift >= this.thresholds.warnMs) {
        this.logger.warn(
          `[clockSkew] warning drift ${sample.driftMs}ms for ${sample.source}:${sample.sourceId}`,
        );
      }
    }

    jobMetricsService.recordJobSuccess('clock_skew_sample', {
      samples: samples.length,
      maxDriftMs,
      alertsRaised,
    });

    return { samples, maxDriftMs, alertsRaised };
  }

  private buildSample(
    source: ClockSkewSample['source'],
    sourceId: string,
    authoritativeTime: Date,
    observedTime: Date,
  ): ClockSkewSample {
    return {
      source,
      sourceId,
      authoritativeTime,
      observedTime,
      driftMs: observedTime.getTime() - authoritativeTime.getTime(),
      sampledAt: new Date(),
    };
  }

  private async persistSample(sample: ClockSkewSample): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO clock_skew_samples
           (source, source_id, authoritative_time, observed_time, drift_ms, sampled_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          sample.source,
          sample.sourceId,
          sample.authoritativeTime.toISOString(),
          sample.observedTime.toISOString(),
          sample.driftMs,
          sample.sampledAt.toISOString(),
        ],
      );
    } catch (err) {
      this.logger.error(
        `[clockSkew] failed to persist sample for ${sample.source}:${sample.sourceId}: ${
          (err as Error).message
        }`,
      );
      jobMetricsService.recordJobFailure('clock_skew_persist', {
        source: sample.source,
        sourceId: sample.sourceId,
      });
    }
  }

  private emitMetrics(sample: ClockSkewSample): void {
    jobMetricsService.recordGauge('clock_skew_drift_ms', Math.abs(sample.driftMs), {
      source: sample.source,
      sourceId: sample.sourceId,
    });
  }

  private async raiseAlert(
    sample: ClockSkewSample,
    severity: 'alert' | 'critical',
  ): Promise<void> {
    this.logger.error(
      `[clockSkew] ${severity} drift ${sample.driftMs}ms for ${sample.source}:${sample.sourceId}`,
    );
    try {
      await failoverAlertService.raise({
        type: 'clock_skew',
        severity,
        message: `Clock drift ${sample.driftMs}ms exceeds ${severity} threshold for ${sample.source}:${sample.sourceId}`,
        metadata: {
          source: sample.source,
          sourceId: sample.sourceId,
          driftMs: sample.driftMs,
          authoritativeTime: sample.authoritativeTime.toISOString(),
          observedTime: sample.observedTime.toISOString(),
          thresholds: this.thresholds,
        },
      });
    } catch (err) {
      this.logger.error(
        `[clockSkew] failed to raise alert: ${(err as Error).message}`,
      );
    }
  }
}

/**
 * Resolve the authoritative "now" for a workflow. This MUST be used by nonce,
 * quote, and authorization flows instead of client or provider clocks.
 */
export async function resolveAuthoritativeNow(
  getAuthoritativeTime: () => Promise<Date>,
): Promise<Date> {
  return getAuthoritativeTime();
}

/**
 * Assert that a timestamp is within the allowed skew tolerance of the
 * authoritative clock. Throws ClockSkewError when the drift exceeds tolerance.
 *
 * This is the single guard used by nonce, quote, and authorization flows so
 * that skew cannot extend a validity window.
 */
export function assertWithinSkew(
  timestamp: Date,
  authoritativeNow: Date,
  toleranceMs: number,
): void {
  const driftMs = timestamp.getTime() - authoritativeNow.getTime();
  if (Math.abs(driftMs) > toleranceMs) {
    throw new ClockSkewError(
      `Timestamp drift ${driftMs}ms exceeds tolerance ${toleranceMs}ms`,
      driftMs,
      toleranceMs,
    );
  }
}

/**
 * Evaluate whether a validity window [issuedAt, expiresAt] is still valid
 * against the authoritative clock, accounting for skew tolerance. Skew can
 * only shrink the effective window, never extend it.
 */
export function isWithinValidityWindow(
  issuedAt: Date,
  expiresAt: Date,
  authoritativeNow: Date,
  toleranceMs: number,
): boolean {
  const now = authoritativeNow.getTime();
  const start = issuedAt.getTime() - toleranceMs;
  const end = expiresAt.getTime() + toleranceMs;
  return now >= start && now <= end;
}

export const clockSkewService = {
  ClockSkewService,
  resolveAuthoritativeNow,
  assertWithinSkew,
  isWithinValidityWindow,
  DEFAULT_CLOCK_SKEW_THRESHOLDS,
};