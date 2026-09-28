import logger from '../utils/logger.js';
import { jobMetricsService } from './jobMetricsService.js';
import { sorobanCircuitBreaker } from './sorobanCircuitBreaker.js';
import {
  sorobanWriteQueue,
  type SorobanQueuedWrite,
  type SorobanWriteQueue,
} from './sorobanWriteQueue.js';
import { sorobanService } from './sorobanService.js';

const JOB_NAME = 'sorobanWriteReplay';

let replayInterval: NodeJS.Timeout | null = null;
let runInFlight = false;

export interface SorobanWriteReplayOptions {
  queue?: SorobanWriteQueue;
  submit?: (write: SorobanQueuedWrite) => Promise<unknown>;
  isAvailable?: () => Promise<boolean>;
  batchSize?: number;
}

export interface SorobanWriteReplayResult {
  skipped: boolean;
  considered: number;
  applied: number;
  failed: number;
}

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function defaultSubmit(write: SorobanQueuedWrite): Promise<unknown> {
  return sorobanService.replayQueuedWrite(write);
}

async function defaultIsAvailable(): Promise<boolean> {
  const availability = await sorobanCircuitBreaker.checkAvailability();
  return availability.available;
}

/**
 * Drains one batch of queued Soroban writes once the RPC is reachable again
 * (issue #74).
 *
 * Writes are replayed in ascending id order and the drain stops at the first
 * failure so a later write can never overtake an earlier one. Failed writes are
 * rescheduled with exponential backoff and remain `pending`, so nothing is lost.
 */
export async function runSorobanWriteReplayOnce(
  options: SorobanWriteReplayOptions = {},
): Promise<SorobanWriteReplayResult> {
  if (runInFlight) {
    return { skipped: true, considered: 0, applied: 0, failed: 0 };
  }

  const queue = options.queue ?? sorobanWriteQueue;
  const submit = options.submit ?? defaultSubmit;
  const isAvailable = options.isAvailable ?? defaultIsAvailable;
  const batchSize = options.batchSize ?? readPositiveInt('SOROBAN_WRITE_REPLAY_BATCH_SIZE', 25);

  if (!(await isAvailable())) {
    return { skipped: true, considered: 0, applied: 0, failed: 0 };
  }

  runInFlight = true;
  const result: SorobanWriteReplayResult = {
    skipped: false,
    considered: 0,
    applied: 0,
    failed: 0,
  };

  try {
    const pending = await queue.listReadyForReplay(batchSize);

    for (const write of pending) {
      result.considered += 1;

      try {
        await submit(write);
        await queue.markApplied(write.id);
        result.applied += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const nextAttemptAt = await queue.markFailed(write.id, message, write.attempts + 1);
        result.failed += 1;

        logger.withContext().warn('Soroban write replay failed; scheduled for retry', {
          id: write.id,
          operation: write.operation,
          nextAttemptAt: nextAttemptAt.toISOString(),
          error: message,
        });

        // Preserve strict ordering: stop so a later write cannot overtake this one.
        break;
      }
    }

    return result;
  } finally {
    runInFlight = false;
  }
}

/**
 * Starts the background replay loop. Safe to call once at startup; repeated
 * calls are ignored.
 */
export function startSorobanWriteReplayProcessor(): void {
  if (replayInterval) {
    logger.withContext().warn('Soroban write replay processor already running');
    return;
  }

  const intervalMs = readPositiveInt('SOROBAN_WRITE_REPLAY_INTERVAL_MS', 15000);
  logger.withContext().info('Starting Soroban write replay processor', { intervalMs });

  replayInterval = setInterval(() => {
    const startedAt = Date.now();
    void runSorobanWriteReplayOnce()
      .then((result) => {
        const durationMs = Date.now() - startedAt;
        if (result.considered > 0) {
          logger.withContext().info('Soroban write replay pass completed', {
            ...result,
            durationMs,
          });
        }
        jobMetricsService.recordSuccess(JOB_NAME, durationMs);
      })
      .catch((error) => {
        jobMetricsService.recordFailure(JOB_NAME, error as Error, Date.now() - startedAt);
        logger.withContext().error('Soroban write replay processor error', { error });
      });
  }, intervalMs);

  replayInterval.unref();
}

/** Stops the background replay loop during graceful shutdown. */
export function stopSorobanWriteReplayProcessor(): void {
  if (replayInterval) {
    clearInterval(replayInterval);
    replayInterval = null;
    logger.withContext().info('Stopped Soroban write replay processor');
  }
}

export function isSorobanWriteReplayProcessorRunning(): boolean {
  return replayInterval !== null;
}
