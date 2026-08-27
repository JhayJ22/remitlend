import { cacheService } from '../services/cacheService.js';
import logger from '../utils/logger.js';
import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../errors/AppError.js';

interface RateLimitConfig {
  max: number; // Max requests
  windowMs: number; // Time window in milliseconds
  keyGenerator?: (req: Request) => string;
  skip?: (req: Request) => boolean;
}

interface RateLimitEntry {
  timestamps: number[];
}

/**
 * Redis-backed sliding window rate limiter using sorted sets.
 * Tracks request timestamps per key and enforces limits across distributed instances.
 *
 * Algorithm:
 * 1. Store request timestamps in a Redis sorted set (score = timestamp)
 * 2. Remove timestamps older than windowMs
 * 3. Count remaining timestamps within window
 * 4. Increment count if below limit
 */
export class DistributedRateLimiter {
  private max: number;
  private windowMs: number;
  private keyGenerator: (req: Request) => string;
  private skip: (req: Request) => boolean;

  constructor(config: RateLimitConfig) {
    this.max = config.max;
    this.windowMs = config.windowMs;
    this.keyGenerator = config.keyGenerator || ((req) => req.ip ?? 'unknown');
    this.skip = config.skip || (() => false);
  }

  private getRedisKey(identifier: string): string {
    return `ratelimit:${identifier}`;
  }

  /**
   * Sliding window log algorithm using Redis sorted sets.
   * Returns: { allowed: boolean, limit: number, remaining: number, resetAfter: number }
   */
  async checkLimit(identifier: string): Promise<{
    allowed: boolean;
    limit: number;
    remaining: number;
    resetAfter: number;
  }> {
    const redisKey = this.getRedisKey(identifier);
    const now = Date.now();
    const windowStart = now - this.windowMs;

    try {
      // Use a Lua script for atomicity: remove old entries, add new one, check count
      const script = `
        local key = KEYS[1]
        local now = tonumber(ARGV[1])
        local windowStart = tonumber(ARGV[2])
        local max = tonumber(ARGV[3])
        local windowMs = tonumber(ARGV[4])

        -- Remove timestamps older than windowStart (sliding window cleanup)
        redis.call('ZREMRANGEBYSCORE', key, '-inf', windowStart)

        -- Count current requests in window
        local count = redis.call('ZCARD', key)

        local allowed = count < max
        local remaining = math.max(0, max - count)

        if allowed then
          -- Add current request timestamp
          redis.call('ZADD', key, now, now)
          -- Set expiry to windowMs from now to auto-cleanup old entries
          redis.call('EXPIRE', key, math.ceil(windowMs / 1000) + 1)
        end

        -- Return: allowed, remaining, resetAfter (oldest timestamp + windowMs)
        local oldestTimestamp = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
        local resetAfter = 0
        if #oldestTimestamp > 0 then
          resetAfter = tonumber(oldestTimestamp[2]) + windowMs
        end

        return { allowed and 1 or 0, remaining, resetAfter }
      `;

      const result = await (cacheService as any).client!.eval(script, {
        keys: [redisKey],
        arguments: [now.toString(), windowStart.toString(), this.max.toString(), this.windowMs.toString()],
      });

      const [allowed, remaining, resetAfter] = result as [number, number, number];

      return {
        allowed: allowed === 1,
        limit: this.max,
        remaining: Math.max(0, remaining),
        resetAfter: Math.max(now, resetAfter),
      };
    } catch (error) {
      logger.error('Error in distributed rate limiter', { identifier, error });
      // Fail open: allow request if Redis is down
      return {
        allowed: true,
        limit: this.max,
        remaining: this.max,
        resetAfter: now + this.windowMs,
      };
    }
  }

  middleware() {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      if (this.skip(req)) {
        return next();
      }

      const identifier = this.keyGenerator(req);
      const result = await this.checkLimit(identifier);

      // Set rate limit headers
      res.setHeader('RateLimit-Limit', result.limit);
      res.setHeader('RateLimit-Remaining', result.remaining);
      res.setHeader('RateLimit-Reset', Math.ceil(result.resetAfter / 1000));

      if (!result.allowed) {
        const retryAfter = Math.ceil((result.resetAfter - Date.now()) / 1000);
        res.setHeader('Retry-After', retryAfter);

        logger.warn('Rate limit exceeded', {
          identifier,
          limit: result.limit,
          retryAfter,
        });

        return next(
          AppError.tooManyRequests(
            `Rate limit exceeded. Retry after ${retryAfter} seconds.`,
          ),
        );
      }

      next();
    };
  }
}

/**
 * Create distributed rate limiters for common use cases
 */

export const createDistributedRateLimiter = (
  maxRequests: number,
  windowMinutes: number = 1,
  keyGenerator?: (req: Request) => string,
) => new DistributedRateLimiter({
  max: maxRequests,
  windowMs: windowMinutes * 60 * 1000,
  keyGenerator,
});

// Global rate limiter: 100 req/15min per IP
export const distributedGlobalRateLimiter = createDistributedRateLimiter(100, 15);

// Per-user rate limiter: 50 req/min per authenticated user
export const createPerUserRateLimiter = () =>
  new DistributedRateLimiter({
    max: 50,
    windowMs: 60 * 1000,
    keyGenerator: (req) => {
      const user = (req as unknown as { user?: { publicKey: string } }).user;
      return user?.publicKey ?? req.ip ?? 'unknown';
    },
  });

// Per-route rate limiters for sensitive endpoints

// Loan operations: 20 req/min per user
export const loanOperationRateLimiter = new DistributedRateLimiter({
  max: 20,
  windowMs: 60 * 1000,
  keyGenerator: (req) => {
    const user = (req as unknown as { user?: { publicKey: string } }).user;
    return user?.publicKey ?? req.ip ?? 'unknown';
  },
});

// Auth endpoints: 10 req/min per IP
export const authRateLimiter = new DistributedRateLimiter({
  max: 10,
  windowMs: 60 * 1000,
  keyGenerator: (req) => req.ip ?? 'unknown',
});

// Simulation endpoints: 5 req/min per user
export const simulationRateLimiter = new DistributedRateLimiter({
  max: 5,
  windowMs: 60 * 1000,
  keyGenerator: (req) => {
    const user = (req as unknown as { user?: { publicKey: string } }).user;
    return user?.publicKey ?? req.ip ?? 'unknown';
  },
  skip: () => process.env.NODE_ENV === 'test',
});
