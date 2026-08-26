import pg, { type PoolClient } from 'pg';
import logger from '../utils/logger.js';

const { Pool } = pg;

export class FailoverPool {
  private primaryPool: pg.Pool | null = null;
  private replicaPool: pg.Pool | null = null;
  private failoverActive = false;
  private healthCheckInterval: NodeJS.Timeout | null = null;

  constructor(primaryUrl: string, replicaUrl?: string) {
    this.primaryPool = new Pool({
      connectionString: primaryUrl,
      min: 2,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });

    if (replicaUrl) {
      this.replicaPool = new Pool({
        connectionString: replicaUrl,
        min: 1,
        max: 5,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
      });
    }

    this.startHealthChecks();
  }

  private startHealthChecks(): void {
    this.healthCheckInterval = setInterval(() => {
      this.checkPrimaryHealth();
    }, 10000);
    this.healthCheckInterval.unref();
  }

  private async checkPrimaryHealth(): Promise<void> {
    if (!this.primaryPool) return;

    try {
      const client = await this.primaryPool.connect();
      await client.query('SELECT 1');
      client.release();
      if (this.failoverActive) {
        logger.info('Primary database recovered, failover deactivated');
        this.failoverActive = false;
      }
    } catch (error) {
      if (!this.failoverActive && this.replicaPool) {
        logger.error('Primary database connection failed, activating failover', { error });
        this.failoverActive = true;
      }
    }
  }

  async query(sql: string, params?: unknown[]): Promise<pg.QueryResult> {
    return this.queryWithRetry(sql, params, 0);
  }

  private async queryWithRetry(
    sql: string,
    params: unknown[] | undefined,
    attemptNumber: number,
  ): Promise<pg.QueryResult> {
    const maxAttempts = 3;
    const maxBackoffMs = 5000;

    try {
      if (!this.failoverActive && this.primaryPool) {
        return await this.primaryPool.query(sql, params);
      }

      if (this.replicaPool && sql.trim().toUpperCase().startsWith('SELECT')) {
        logger.info('Executing read query on replica due to failover', {
          attempt: attemptNumber + 1,
        });
        return await this.replicaPool.query(sql, params);
      }

      if (this.primaryPool) {
        return await this.primaryPool.query(sql, params);
      }

      throw new Error('No database connections available');
    } catch (error) {
      if (attemptNumber < maxAttempts) {
        const backoffMs = Math.min(
          1000 * Math.pow(2, attemptNumber) + Math.random() * 1000,
          maxBackoffMs,
        );
        logger.warn('Database query failed, retrying', {
          attempt: attemptNumber + 1,
          maxAttempts,
          backoffMs,
          error: error instanceof Error ? error.message : String(error),
        });

        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        return this.queryWithRetry(sql, params, attemptNumber + 1);
      }

      logger.error('Database query failed after max retries', {
        attempts: maxAttempts,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async connect(): Promise<PoolClient> {
    const maxAttempts = 3;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        if (!this.failoverActive && this.primaryPool) {
          return await this.primaryPool.connect();
        }

        if (this.replicaPool) {
          logger.info('Connecting to replica due to failover');
          return await this.replicaPool.connect();
        }

        if (this.primaryPool) {
          return await this.primaryPool.connect();
        }

        throw new Error('No database pools available');
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt < maxAttempts - 1) {
          const backoffMs = 500 * Math.pow(2, attempt);
          logger.warn('Connection attempt failed, retrying', {
            attempt: attempt + 1,
            maxAttempts,
            backoffMs,
          });
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }
      }
    }

    throw lastError || new Error('Failed to connect after max retries');
  }

  async end(): Promise<void> {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    const promises = [];
    if (this.primaryPool) {
      promises.push(this.primaryPool.end());
    }
    if (this.replicaPool) {
      promises.push(this.replicaPool.end());
    }

    await Promise.all(promises);
    logger.info('Failover pool connections closed');
  }

  isFailoverActive(): boolean {
    return this.failoverActive;
  }
}
