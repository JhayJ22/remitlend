import type { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger.js';

/**
 * Middleware to track and coordinate graceful shutdown.
 * Prevents new requests during shutdown while draining in-flight requests.
 */
class ShutdownCoordinator {
  private isShuttingDown = false;
  private activeRequests = 0;
  private maxWaitMs = 30_000;

  /**
   * Middleware that:
   * 1. Rejects new requests if shutdown has begun
   * 2. Tracks active request count
   * 3. Ensures request completion is logged
   */
  middleware() {
    return (req: Request, res: Response, next: NextFunction): void => {
      if (this.isShuttingDown) {
        res.status(503).json({
          error: 'Server is shutting down',
          message: 'Please retry after the server restarts',
        });
        return;
      }

      this.activeRequests++;

      // Track request completion
      res.on('finish', () => {
        this.activeRequests--;
        logger.debug(`Request completed. Active requests: ${this.activeRequests}`);
      });

      res.on('close', () => {
        if (!res.writableEnded) {
          this.activeRequests--;
          logger.warn(`Request aborted/closed. Active requests: ${this.activeRequests}`);
        }
      });

      next();
    };
  }

  /**
   * Begin shutdown: stop accepting new requests and wait for in-flight to complete.
   * Returns promise that resolves when all requests complete or timeout expires.
   */
  async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    logger.info('Shutdown initiated. Stopping new requests.');

    const startTime = Date.now();
    const checkInterval = 100;

    return new Promise<void>((resolve) => {
      const check = () => {
        const elapsedMs = Date.now() - startTime;
        if (this.activeRequests === 0) {
          logger.info('All in-flight requests completed');
          resolve();
          return;
        }

        if (elapsedMs >= this.maxWaitMs) {
          logger.warn(`Shutdown timeout: ${this.activeRequests} requests still active after 30s`);
          resolve();
          return;
        }

        logger.debug(
          `Draining requests: ${this.activeRequests} active, ${Math.round(elapsedMs / 1000)}s elapsed`,
        );
        setTimeout(check, checkInterval);
      };

      check();
    });
  }

  /**
   * Get current state for monitoring.
   */
  getStatus() {
    return {
      isShuttingDown: this.isShuttingDown,
      activeRequests: this.activeRequests,
    };
  }
}

export const shutdownCoordinator = new ShutdownCoordinator();
