import type { NextFunction, Request, Response } from 'express';
import {
  sorobanCircuitBreaker,
  type SorobanDegradationStatus,
} from '../services/sorobanCircuitBreaker.js';

const READ_METHODS = new Set(['GET', 'HEAD']);

/**
 * Shape of the transport-level degradation banner attached to read responses.
 */
export interface SorobanDegradationBanner {
  state: SorobanDegradationStatus['state'];
  since: number | null;
  warning: string | null;
}

function buildBanner(status: SorobanDegradationStatus): SorobanDegradationBanner {
  return {
    state: status.state,
    since: status.lastFailureAt,
    warning: status.warning,
  };
}

/**
 * Express middleware that surfaces the Soroban RPC degradation state to read
 * clients (issue #74).
 *
 * While the RPC circuit is open — or stale data was just served — GET/HEAD
 * responses gain `degraded: true`, a `warnings` array and a `soroban` banner,
 * plus an `x-soroban-degraded: true` header. The frontend can render this as
 * the warning banner without every controller having to know about the circuit.
 */
export function sorobanDegradationBanner(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!READ_METHODS.has(req.method)) {
    next();
    return;
  }

  const originalJson = res.json.bind(res);

  res.json = (body?: unknown): Response => {
    const status = sorobanCircuitBreaker.getStatus();

    if (
      !status.degraded ||
      body === null ||
      typeof body !== 'object' ||
      Array.isArray(body)
    ) {
      return originalJson(body);
    }

    const record = body as Record<string, unknown>;
    if (record.degraded === true) {
      return originalJson(body);
    }

    res.setHeader('x-soroban-degraded', 'true');

    return originalJson({
      ...record,
      degraded: true,
      warnings: status.warning ? [status.warning] : [],
      soroban: buildBanner(status),
    });
  };

  next();
}
