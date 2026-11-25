/**
 * Cache-invalidation propagation middleware (#853).
 *
 * When a deletion or revocation endpoint sets the `Cache-Invalidation-Token`
 * response header, this middleware ensures the header is forwarded to the
 * browser and is included in the CORS exposed-headers list so JavaScript can
 * read it.
 *
 * Header format:
 *   Cache-Invalidation-Token: projections:{userId}[,projections:{userId2},…]
 *
 * The frontend `apiClient` reads this header on every response and calls
 * `evictReadCacheByToken(token)` for each comma-separated token, removing the
 * matching entry from the in-memory READ_CACHE map so a stale serving cannot
 * occur even while the browser remains online.
 */

import type { Request, Response, NextFunction } from 'express';

export const CACHE_INVALIDATION_HEADER = 'Cache-Invalidation-Token';

/**
 * Express middleware that ensures the `Cache-Invalidation-Token` header
 * survives compression and is marked as a Vary-safe, no-store field.
 *
 * Mount this after the CORS and compression middleware so it runs for every
 * response that carries the header.
 */
export function cacheInvalidationHeaderMiddleware(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  const originalJson = res.json.bind(res);

  // Intercept json() so we can inspect the outbound headers before they are
  // sealed.  We only act when the deletion controller already set the token.
  res.json = function patchedJson(body: unknown): Response {
    const token = res.getHeader(CACHE_INVALIDATION_HEADER);
    if (token) {
      // Prevent downstream proxies from caching a response that invalidates
      // cached projections.
      res.setHeader('Cache-Control', 'no-store');
      // Ensure the header is not stripped by compression middleware.
      res.setHeader('Vary', 'Cache-Invalidation-Token');
    }
    return originalJson(body);
  };

  next();
}

/**
 * Build a Cache-Invalidation-Token value for a set of user IDs.
 * Used by the deletion service so the token format is defined in one place.
 */
export function buildInvalidationToken(userIds: string[]): string {
  return userIds.map((id) => `projections:${id}`).join(',');
}

/**
 * Parse a raw Cache-Invalidation-Token header value into an array of tokens.
 */
export function parseInvalidationTokens(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * Extract the user ID encoded in a projection invalidation token.
 * Returns null for tokens that do not follow the `projections:{userId}` format.
 */
export function extractUserIdFromToken(token: string): string | null {
  const PREFIX = 'projections:';
  if (!token.startsWith(PREFIX)) return null;
  const userId = token.slice(PREFIX.length);
  return userId.length > 0 ? userId : null;
}
