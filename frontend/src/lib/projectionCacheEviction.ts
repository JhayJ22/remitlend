/**
 * Frontend cache eviction for deleted or revoked financial projections (#853).
 *
 * When the backend deletes a user's cached projections it sets the response
 * header `Cache-Invalidation-Token: projections:{userId}`.  This module
 * intercepts that header and purges matching entries from two layers:
 *
 *   1. The in-memory `READ_CACHE` map inside `apiClient.ts`
 *      (evictReadCacheByToken exported from apiClient).
 *   2. The React Query `queryClient` (scores, loans, remittances keyed by
 *      the affected userId).
 *
 * Usage: import `applyProjectionCacheEviction` and call it after any
 * mutation response that may carry a Cache-Invalidation-Token.  The
 * `useProjectionCacheEviction` React hook wires this up automatically for
 * mutation callbacks.
 */

import type { QueryClient } from '@tanstack/react-query';
import { evictReadCacheByToken } from '../services/apiClient.js';
import { invalidate, queryKeys } from './queryClient.js';

// ── Token parsing ─────────────────────────────────────────────────────────────

const PROJECTION_PREFIX = 'projections:';

/**
 * Parse the raw header value into an array of token strings.
 */
export function parseInvalidationTokens(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * Extract the userId encoded inside a `projections:{userId}` token.
 * Returns null for tokens that use a different namespace.
 */
export function extractUserIdFromToken(token: string): string | null {
  if (!token.startsWith(PROJECTION_PREFIX)) return null;
  const userId = token.slice(PROJECTION_PREFIX.length);
  return userId.length > 0 ? userId : null;
}

// ── Eviction ──────────────────────────────────────────────────────────────────

/**
 * Evict cached projections from both the apiClient in-memory read cache and
 * the React Query cache for every userId encoded in `rawTokenHeader`.
 *
 * This is the primary eviction entry point.  Call it inside a mutation's
 * `onSuccess` callback after the backend responds with a
 * Cache-Invalidation-Token header.
 *
 * @param rawTokenHeader  The raw string value of the Cache-Invalidation-Token
 *                        response header, or null/undefined when absent.
 * @param queryClient     The React Query client to invalidate projections on.
 */
export function applyProjectionCacheEviction(
  rawTokenHeader: string | null | undefined,
  queryClient: QueryClient,
): void {
  const tokens = parseInvalidationTokens(rawTokenHeader);
  if (tokens.length === 0) return;

  for (const token of tokens) {
    // 1. Purge apiClient READ_CACHE (in-memory per-session fetch cache).
    evictReadCacheByToken(token);

    // 2. Invalidate React Query cache entries.
    const userId = extractUserIdFromToken(token);
    if (userId) {
      // Invalidate score queries for this subject.
      void invalidate.scores(queryClient, userId);
      // Invalidate loan queries for this borrower (borrower:loans key).
      void queryClient.invalidateQueries({ queryKey: queryKeys.loans.all });
    }
  }
}

/**
 * Evict all projection entries regardless of userId.
 *
 * Used when a bulk-delete response covers more users than were enumerated in
 * the token, or as a defensive full-flush after a suspected cache poisoning
 * incident.
 */
export function evictAllProjections(queryClient: QueryClient): void {
  evictReadCacheByToken(PROJECTION_PREFIX);
  void invalidate.scores(queryClient);
  void queryClient.invalidateQueries({ queryKey: queryKeys.loans.all });
}
