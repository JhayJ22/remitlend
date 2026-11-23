import pg, { type PoolClient, type QueryResult } from 'pg';
import logger from '../utils/logger.js';
import { recordFailoverEvent } from '../services/failoverAlertService.js';

const { Pool } = pg;

/**
 * Minimal pool surface used by FailoverPool. Lets tests inject fakes.
 */
export interface QueryablePool {
  query(sql: string, params?: unknown[]): Promise<QueryResult>;
  connect(): Promise<PoolClient>;
  end(): Promise<void>;
}

export interface FailoverPoolOptions {
  primaryUrl?: string;
  replicaUrl?: string;
  /** Pre-built pools (tests / custom wiring). Take precedence over URLs. */
  primaryPool?: QueryablePool;
  replicaPool?: QueryablePool | null;
  /** Route SELECT queries to the replica during normal operation. Default: DB_READ_FROM_REPLICA === 'true'. */
  readFromReplica?: boolean;
  /** Max time a write waits in the queue while the primary is down. Default: DB_FAILOVER_TIMEOUT_MS or 30 000. */
  failoverTimeoutMs?: number;
  /** Health-check interval in ms (0 disables the timer). Default: DB_HEALTH_CHECK_INTERVAL_MS or 10 000. */
  healthCheckIntervalMs?: number;
}

export class FailoverWriteTimeoutError extends Error {
  readonly code = 'DB_FAILOVER_TIMEOUT';
  constructor(timeoutMs: number) {
    super(`Primary database unavailable; write timed out after ${timeoutMs} ms in failover queue`);
    this.name = 'FailoverWriteTimeoutError';
  }
}

interface QueuedWrite {
  sql: string;
  params: unknown[] | undefined;
  resolve: (result: QueryResult) => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
}

const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EHOSTUNREACH',
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '08000', // connection_exception
  '08003', // connection_does_not_exist
  '08006', // connection_failure
  '08001', // sqlclient_unable_to_establish_sqlconnection
]);

export function isConnectionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && CONNECTION_ERROR_CODES.has(code)) return true;
  const message = error instanceof Error ? error.message : '';
  return /ECONNREFUSED|Connection terminated|timeout exceeded when trying to connect|the database system is (shutting down|starting up)/i.test(
    message,
  );
}

export function isReadQuery(sql: string): boolean {
  const normalized = sql.trim().replace(/^\(+/, '').toUpperCase();
  if (!(normalized.startsWith('SELECT') || normalized.startsWith('WITH') || normalized.startsWith('SHOW'))) {
    return false;
  }
  // Locking reads and data-modifying CTEs must go to the primary.
  return !/\bFOR\s+(UPDATE|SHARE|NO\s+KEY\s+UPDATE|KEY\s+SHARE)\b|\b(INSERT|UPDATE|DELETE)\b|\bNEXTVAL\s*\(/i.test(
    normalized,
  );
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Primary/replica connection manager.
 *
 * - Reads (SELECT/WITH/SHOW without locking clauses) go to the replica when
 *   `readFromReplica` is enabled, or whenever the primary is down.
 * - When the primary is down, writes are queued for up to
 *   `failoverTimeoutMs` and a `failover_activated` alert is emitted.
 * - When the primary recovers (detected by the health check), queued writes
 *   drain in FIFO order and normal routing resumes.
 */
export class FailoverPool {
  private readonly primaryPool: QueryablePool;
  private readonly replicaPool: QueryablePool | null;
  private readonly readFromReplica: boolean;
  private readonly failoverTimeoutMs: number;
  private failoverActive = false;
  private draining = false;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private readonly writeQueue: QueuedWrite[] = [];

  constructor(primaryUrlOrOptions: string | FailoverPoolOptions, replicaUrl?: string) {
    const opts: FailoverPoolOptions =
      typeof primaryUrlOrOptions === 'string'
        ? { primaryUrl: primaryUrlOrOptions, replicaUrl }
        : primaryUrlOrOptions;

    if (opts.primaryPool) {
      this.primaryPool = opts.primaryPool;
    } else if (opts.primaryUrl) {
      this.primaryPool = new Pool({
        connectionString: opts.primaryUrl,
        min: 2,
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
      });
    } else {
      throw new Error('FailoverPool requires a primary pool or primaryUrl');
    }

    if (opts.replicaPool !== undefined) {
      this.replicaPool = opts.replicaPool;
    } else if (opts.replicaUrl) {
      this.replicaPool = new Pool({
        connectionString: opts.replicaUrl,
        min: 1,
        max: 5,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
      });
    } else {
      this.replicaPool = null;
    }

    this.readFromReplica = opts.readFromReplica ?? process.env.DB_READ_FROM_REPLICA === 'true';
    this.failoverTimeoutMs = opts.failoverTimeoutMs ?? envInt('DB_FAILOVER_TIMEOUT_MS', 30000);

    const interval = opts.healthCheckIntervalMs ?? envInt('DB_HEALTH_CHECK_INTERVAL_MS', 10000);
    if (interval > 0) {
      this.healthCheckInterval = setInterval(() => {
        void this.checkPrimaryHealth();
      }, interval);
      this.healthCheckInterval.unref();
    }
  }

  /** Probe the primary; activates or deactivates failover accordingly. */
  async checkPrimaryHealth(): Promise<boolean> {
    try {
      await this.primaryPool.query('SELECT 1');
      if (this.failoverActive) this.deactivateFailover();
      return true;
    } catch (error) {
      if (!this.failoverActive) this.activateFailover(error);
      return false;
    }
  }

  private activateFailover(error: unknown): void {
    if (this.failoverActive) return;
    this.failoverActive = true;
    logger.error('Primary database unavailable, failover activated', {
      error: error instanceof Error ? error.message : String(error),
      replicaAvailable: Boolean(this.replicaPool),
    });
    recordFailoverEvent({
      type: 'failover_activated',
      details: { error: error instanceof Error ? error.message : String(error) },
    });
  }

  private deactivateFailover(): void {
    this.failoverActive = false;
    logger.info('Primary database recovered, failover deactivated', {
      queuedWrites: this.writeQueue.length,
    });
    recordFailoverEvent({ type: 'failover_deactivated', details: {} });
    void this.drainQueue();
  }

  private async drainQueue(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.writeQueue.length > 0 && !this.failoverActive) {
        const item = this.writeQueue[0];
        try {
          const result = await this.primaryPool.query(item.sql, item.params);
          this.writeQueue.shift();
          clearTimeout(item.timer);
          item.resolve(result);
        } catch (error) {
          if (isConnectionError(error)) {
            // Primary dropped again: keep the item queued (its timer is still running).
            this.activateFailover(error);
            break;
          }
          this.writeQueue.shift();
          clearTimeout(item.timer);
          item.reject(error);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private enqueueWrite(sql: string, params: unknown[] | undefined): Promise<QueryResult> {
    return new Promise<QueryResult>((resolve, reject) => {
      const item: QueuedWrite = {
        sql,
        params,
        resolve,
        reject,
        timer: setTimeout(() => {
          const idx = this.writeQueue.indexOf(item);
          if (idx !== -1) this.writeQueue.splice(idx, 1);
          recordFailoverEvent({
            type: 'write_queue_timeout',
            details: { error: `write timed out after ${this.failoverTimeoutMs} ms` },
          });
          reject(new FailoverWriteTimeoutError(this.failoverTimeoutMs));
        }, this.failoverTimeoutMs),
      };
      item.timer.unref?.();
      this.writeQueue.push(item);
    });
  }

  async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    const read = isReadQuery(sql);

    if (read && this.replicaPool && (this.failoverActive || this.readFromReplica)) {
      try {
        return await this.replicaPool.query(sql, params);
      } catch (error) {
        if (this.failoverActive || !isConnectionError(error)) throw error;
        logger.warn('Replica read failed, falling back to primary', {
          error: error instanceof Error ? error.message : String(error),
        });
        return this.primaryPool.query(sql, params);
      }
    }

    if (this.failoverActive) {
      if (read) throw new Error('Primary database unavailable and no replica configured');
      return this.enqueueWrite(sql, params);
    }

    try {
      return await this.primaryPool.query(sql, params);
    } catch (error) {
      if (!isConnectionError(error)) throw error;
      this.activateFailover(error);
      if (read && this.replicaPool) return this.replicaPool.query(sql, params);
      if (read) throw error;
      return this.enqueueWrite(sql, params);
    }
  }

  async connect(): Promise<PoolClient> {
    if (!this.failoverActive) {
      try {
        return await this.primaryPool.connect();
      } catch (error) {
        if (!isConnectionError(error)) throw error;
        this.activateFailover(error);
      }
    }
    if (this.replicaPool) {
      logger.warn('Primary unavailable, handing out read-only replica client');
      return this.replicaPool.connect();
    }
    throw new Error('Primary database unavailable and no replica configured');
  }

  async end(): Promise<void> {
    if (this.healthCheckInterval) clearInterval(this.healthCheckInterval);
    for (const item of this.writeQueue.splice(0)) {
      clearTimeout(item.timer);
      item.reject(new Error('FailoverPool closed'));
    }
    await Promise.all([this.primaryPool.end(), this.replicaPool?.end()].filter(Boolean));
    logger.info('Failover pool connections closed');
  }

  isFailoverActive(): boolean {
    return this.failoverActive;
  }

  getQueuedWriteCount(): number {
    return this.writeQueue.length;
  }
}
