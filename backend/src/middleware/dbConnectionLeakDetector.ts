import type { Request, Response, NextFunction } from 'express';
import { pool } from '../db/connection.js';
import logger from '../utils/logger.js';

interface ConnectionTracker {
  requestId: string;
  method: string;
  path: string;
  acquiredAt: number;
  clientId?: number;
  released: boolean;
  releasedAt?: number;
  duration?: number;
}

const activeConnections = new Map<string, ConnectionTracker>();
const LONG_QUERY_THRESHOLD_MS = parseInt(process.env.DB_LONG_QUERY_THRESHOLD_MS ?? '5000', 10);
const CONNECTION_LEAK_THRESHOLD_MS = parseInt(process.env.DB_CONNECTION_LEAK_THRESHOLD_MS ?? '30000', 10);
const CLEANUP_INTERVAL_MS = 60000;

let cleanupInterval: NodeJS.Timeout | null = null;

function generateRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

function startCleanupInterval(): void {
  if (cleanupInterval) return;

  cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [requestId, tracker] of activeConnections.entries()) {
      if (!tracker.released && now - tracker.acquiredAt > CONNECTION_LEAK_THRESHOLD_MS) {
        logger.warn('Potential database connection leak detected', {
          requestId,
          method: tracker.method,
          path: tracker.path,
          durationMs: now - tracker.acquiredAt,
          clientId: tracker.clientId,
        });
      }

      if (tracker.released && tracker.releasedAt && now - tracker.releasedAt > 300000) {
        activeConnections.delete(requestId);
      }
    }
  }, CLEANUP_INTERVAL_MS);

  cleanupInterval.unref();
}

function stopCleanupInterval(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}

export function trackConnectionAcquisition(
  requestId: string,
  method: string,
  path: string,
  clientId?: number,
): void {
  startCleanupInterval();

  activeConnections.set(requestId, {
    requestId,
    method,
    path,
    acquiredAt: Date.now(),
    clientId,
    released: false,
  });
}

export function trackConnectionRelease(requestId: string): void {
  const tracker = activeConnections.get(requestId);
  if (tracker) {
    const now = Date.now();
    tracker.released = true;
    tracker.releasedAt = now;
    tracker.duration = now - tracker.acquiredAt;

    if (tracker.duration > LONG_QUERY_THRESHOLD_MS) {
      logger.warn('Long-running database connection detected', {
        requestId,
        method: tracker.method,
        path: tracker.path,
        durationMs: tracker.duration,
        clientId: tracker.clientId,
      });
    }
  }
}

export function getActiveConnections(): ConnectionTracker[] {
  return Array.from(activeConnections.values()).filter((t) => !t.released);
}

export function getConnectionStats(): {
  total: number;
  active: number;
  released: number;
  potentialLeaks: number;
} {
  const trackers = Array.from(activeConnections.values());
  const active = trackers.filter((t) => !t.released);
  const potentialLeaks = active.filter(
    (t) => Date.now() - t.acquiredAt > CONNECTION_LEAK_THRESHOLD_MS,
  ).length;

  return {
    total: trackers.length,
    active: active.length,
    released: trackers.filter((t) => t.released).length,
    potentialLeaks,
  };
}

export function clearConnectionTracker(requestId: string): void {
  activeConnections.delete(requestId);
}

export const dbConnectionLeakDetector = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const requestId = req.requestId ?? generateRequestId();
  req.requestId = requestId;

  const originalSend = res.send;
  let connectionTracked = false;

  res.send = function (body?: any): Response {
    if (!connectionTracked) {
      trackConnectionRelease(requestId);
      connectionTracked = true;
    }
    return originalSend.call(this, body);
  };

  res.on('finish', () => {
    if (!connectionTracked) {
      trackConnectionRelease(requestId);
    }
  });

  res.on('close', () => {
    if (!connectionTracked) {
      trackConnectionRelease(requestId);
    }
  });

  next();
};

export const withConnectionTracking = async <T>(
  requestId: string,
  method: string,
  path: string,
  operation: (client: any) => Promise<T>,
): Promise<T> => {
  let client;
  let clientId: number | undefined;

  try {
    client = await pool.connect();
    clientId = (client as any).processID;
    trackConnectionAcquisition(requestId, method, path, clientId);

    return await operation(client);
  } finally {
    if (client) {
      client.release();
      trackConnectionRelease(requestId);
    }
  }
};

export function getPoolMetrics(): {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
  activeCount: number;
} {
  return {
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
    activeCount: pool.totalCount - pool.idleCount,
  };
}

export function setupConnectionLeakDetection(): void {
  startCleanupInterval();

  logger.info('Database connection leak detector initialized', {
    longQueryThresholdMs: LONG_QUERY_THRESHOLD_MS,
    leakThresholdMs: CONNECTION_LEAK_THRESHOLD_MS,
  });
}

export function shutdownConnectionLeakDetection(): void {
  stopCleanupInterval();
  activeConnections.clear();
}