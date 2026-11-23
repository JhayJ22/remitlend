import logger from '../utils/logger.js';
import {
  getNetworkTelemetrySnapshot,
  setStormAlertState,
  isStormAlertActive,
  recordFailoverMetric,
} from './networkTelemetryService.js';
import { getNetworkFailoverStatus, recordFailoverEvent } from './networkFailoverService.js';

/**
 * Retry-storm alerting for transaction submission (#857).
 *
 * A retry storm forms when repeated submission failures drive the durable
 * write queue to grow while the network keeps asking the client to retry,
 * which in turn amplifies outbound load and can degrade submission for every
 * user. This service watches three independent backpressure indicators —
 * write-queue depth, per-network throttle rate, and per-network consecutive
 * failures — and raises a single, deduplicated alert *before* the storm
 * degrades submission, then clears it once the system recovers.
 *
 * The alert is emitted through the existing `FAILOVER_ALERT_WEBHOOK` sink and
 * persisted as a `retry_storm_alert` / `retry_storm_recovered` event in
 * `network_failover_events` for auditability. A cooldown bounds re-alerting so
 * a flapping signal cannot spam operators.
 */

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readFraction(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : fallback;
}

function pendingThreshold(): number {
  return readPositiveInt('TX_SUBMISSION_STORM_PENDING_THRESHOLD', 50);
}
function consecutiveFailureThreshold(): number {
  return readPositiveInt('TX_SUBMISSION_STORM_CONSECUTIVE_FAILURES', 10);
}
function throttleRateThreshold(): number {
  return readFraction('TX_SUBMISSION_STORM_THROTTLE_RATE_THRESHOLD', 0.5);
}
function cooldownMs(): number {
  return readPositiveInt('TX_SUBMISSION_STORM_COOLDOWN_MS', 60000);
}
/** Minimum interval between full evaluations (bounds DB load under load). */
function evalIntervalMs(): number {
  return readPositiveInt('TX_SUBMISSION_STORM_EVAL_INTERVAL_MS', 5000);
}

export interface StormIndicators {
  pendingQueueDepth: number;
  maxConsecutiveFailures: number;
  maxThrottleRate: number;
  breachedReasons: string[];
}

export interface StormEvaluationResult {
  indicators: StormIndicators;
  alertActive: boolean;
  transitionedTo: 'alert' | 'recovered' | null;
}

let lastEvalAt = 0;
let lastAlertAt = 0;

/** Computes the current backpressure indicators and the breached reasons. */
export async function collectStormIndicators(): Promise<StormIndicators> {
  const telemetry = await getNetworkTelemetrySnapshot();
  const failover = getNetworkFailoverStatus();

  const reasons: string[] = [];
  const pending = telemetry.writeQueue.pending;
  if (pending >= pendingThreshold()) {
    reasons.push(`write_queue_pending=${pending}>=${pendingThreshold()}`);
  }

  let maxConsecutive = 0;
  let maxThrottle = 0;
  for (const endpoint of failover.endpoints) {
    if (endpoint.consecutiveFailures > maxConsecutive) {
      maxConsecutive = endpoint.consecutiveFailures;
    }
  }
  for (const net of telemetry.networks) {
    if (net.throttleRate > maxThrottle) maxThrottle = net.throttleRate;
  }
  if (maxConsecutive >= consecutiveFailureThreshold()) {
    reasons.push(`consecutive_failures=${maxConsecutive}>=${consecutiveFailureThreshold()}`);
  }
  if (maxThrottle >= throttleRateThreshold()) {
    reasons.push(`throttle_rate=${maxThrottle.toFixed(3)}>=${throttleRateThreshold()}`);
  }

  return {
    pendingQueueDepth: pending,
    maxConsecutiveFailures: maxConsecutive,
    maxThrottleRate: maxThrottle,
    breachedReasons: reasons,
  };
}

/**
 * Evaluates backpressure and raises/clears the retry-storm alert. Debounced:
 * calls within `TX_SUBMISSION_STORM_EVAL_INTERVAL_MS` of the last evaluation
 * are no-ops (return the last result) so this is cheap to call from hot paths.
 */
export async function evaluateRetryStorm(force = false): Promise<StormEvaluationResult> {
  const now = Date.now();
  if (!force && now - lastEvalAt < evalIntervalMs()) {
    return {
      indicators: {
        pendingQueueDepth: 0,
        maxConsecutiveFailures: 0,
        maxThrottleRate: 0,
        breachedReasons: [],
      },
      alertActive: isStormAlertActive(),
      transitionedTo: null,
    };
  }
  lastEvalAt = now;

  try {
    const indicators = await collectStormIndicators();
    const breaching = indicators.breachedReasons.length > 0;
    const currentlyAlerting = isStormAlertActive();

    let transitionedTo: 'alert' | 'recovered' | null = null;

    if (breaching && !currentlyAlerting) {
      if (now - lastAlertAt < cooldownMs()) {
        // Within the re-alert cooldown: stay silent but keep the (cleared) state.
        return { indicators, alertActive: false, transitionedTo: null };
      }
      lastAlertAt = now;
      setStormAlertState(true);
      transitionedTo = 'alert';
      const reason = indicators.breachedReasons.join('; ');
      logger
        .withContext({ module: 'retry-storm-alert' })
        .error('Retry-storm alert raised: transaction submission backpressure detected', {
          reason,
          indicators,
        });
      recordFailoverMetric('retry_storm_alert');
      void sendStormWebhook('critical', 'Retry-storm alert raised', reason, indicators);
      void recordFailoverEvent({
        toId: failoverActiveId(),
        fromId: null,
        eventType: 'retry_storm_alert',
        details: { reason, indicators },
      });
    } else if (!breaching && currentlyAlerting) {
      setStormAlertState(false);
      transitionedTo = 'recovered';
      logger
        .withContext({ module: 'retry-storm-alert' })
        .info('Retry-storm alert cleared: transaction submission backpressure resolved');
      recordFailoverMetric('retry_storm_recovered');
      void sendStormWebhook('info', 'Retry-storm alert cleared', 'Backpressure resolved.', indicators);
      void recordFailoverEvent({
        toId: failoverActiveId(),
        fromId: null,
        eventType: 'retry_storm_recovered',
        details: { indicators },
      });
    }

    return { indicators, alertActive: isStormAlertActive(), transitionedTo };
  } catch (error) {
    // A telemetry/failover read failure must never break submission or replay.
    logger
      .withContext({ module: 'retry-storm-alert' })
      .warn('Retry-storm evaluation failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    return {
      indicators: {
        pendingQueueDepth: 0,
        maxConsecutiveFailures: 0,
        maxThrottleRate: 0,
        breachedReasons: [],
      },
      alertActive: isStormAlertActive(),
      transitionedTo: null,
    };
  }
}

function failoverActiveId(): string {
  return getNetworkFailoverStatus().activeEndpointId;
}

async function sendStormWebhook(
  severity: string,
  title: string,
  description: string,
  indicators: StormIndicators,
): Promise<void> {
  const webhookUrl = process.env.FAILOVER_ALERT_WEBHOOK;
  if (!webhookUrl) return;
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        severity,
        title,
        description,
        details: {
          pendingQueueDepth: indicators.pendingQueueDepth,
          maxConsecutiveFailures: indicators.maxConsecutiveFailures,
          maxThrottleRate: indicators.maxThrottleRate,
        },
      }),
    });
    if (!response.ok) {
      logger
        .withContext({ module: 'retry-storm-alert' })
        .warn('Retry-storm alert webhook returned non-OK status', { status: response.status });
    }
  } catch (error) {
    logger
      .withContext({ module: 'retry-storm-alert' })
      .warn('Failed to send retry-storm alert webhook', {
        error: error instanceof Error ? error.message : String(error),
      });
  }
}

/** Reset in-memory state. Intended for tests. */
export function resetRetryStormState(): void {
  lastEvalAt = 0;
  lastAlertAt = 0;
  setStormAlertState(false);
}
