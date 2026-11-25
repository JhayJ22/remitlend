# Secure Deletion Contract for Cached Financial Projections

**Issue:** #853  
**Status:** Implemented  
**Affects:** Redis cache, in-process SWR memory, frontend React Query cache, frontend in-memory read cache  

---

## Overview

Financial projections (credit scores, score breakdowns, borrower loan aggregates, on-chain score history, NFT metadata) are cached in Redis for read performance. This document defines the authoritative contract for securely deleting or revoking those cached records so that:

- Deleted or revoked projections cannot be served from any stale replica
- Every deletion and revocation is auditable
- Redis unavailability cannot silently serve stale data to the frontend
- No partial financial side effects occur from invalid or stale actions

---

## Supported States

The lifecycle of a cached projection key is:

```
warm (fresh) → warm (stale) → expired (TTL) 
             ↘ securely deleted (admin action)
             ↘ revoked (compliance action with explicit reason)
```

| State | Description |
|---|---|
| `fresh` | Served directly from cache; age < freshTtl |
| `stale` | Served from cache immediately; background refresh queued |
| `expired` | Key TTL elapsed; next read computes from DB/chain |
| `deleted` | Key removed by an explicit admin DELETE action |
| `revoked` | Key removed by a compliance REVOKE action with an audit reason |

---

## Redis Keys Covered

All keys are deleted by exact-key `DEL` (never `SCAN`/`KEYS` to avoid blocking Redis).

| Key | Type | TTL | Namespace |
|---|---|---|---|
| `score:response:v{N}:{userId}` | SWR envelope | 60 s fresh + 300 s stale | Versioned score response |
| `score:breakdown:v{N}:{userId}` | SWR envelope | 60 s fresh + 300 s stale | Versioned score breakdown |
| `score:history:onchain:{userId}` | JSON | 60 s | On-chain score history |
| `score:nft:{userId}` | JSON | 60 s | NFT metadata |
| `borrower:loans:{userId}` | JSON | 300 s | Borrower loan aggregate |
| `score:userId:{userId}` *(legacy)* | JSON | orphaned | Pre-v1 score key |
| `score:breakdown:{userId}` *(legacy)* | JSON | orphaned | Pre-v1 breakdown key |

**Global keys** (not user-specific, TTL-bound only, not targeted by per-user deletion):

| Key | Type | TTL |
|---|---|---|
| `pool:stats` | JSON | 300 s |
| `pool:share-price:{token}` | JSON | 30 s |

---

## API Endpoints

All endpoints require a valid admin-role JWT (`Authorization: Bearer <token>`) and are rate-limited.

### Delete a single user's projections

```
DELETE /api/v1/admin/cache/projections/:userId
```

**Authorization:** admin JWT  
**Response codes:**
- `200` — All keys confirmed deleted; `Cache-Invalidation-Token` header set
- `207` — Partial deletion; at least one Redis key unconfirmed (Redis degraded)
- `400` — Invalid `userId` parameter
- `401` / `403` — Auth failure

**Response body (200):**
```json
{
  "success": true,
  "data": {
    "subject": "GBORROWER…",
    "deletedAt": "2026-11-20T10:00:00.000Z",
    "keys": {
      "score_response": true,
      "score_breakdown": true,
      "score_history_onchain": true,
      "score_nft": true,
      "borrower_loans": true,
      "legacy_score_response": true,
      "legacy_score_breakdown": true
    },
    "allConfirmed": true,
    "hasUnconfirmedDeletes": false
  }
}
```

**Response body (207 — Redis degraded):**
```json
{
  "success": true,
  "data": { "…", "hasUnconfirmedDeletes": true },
  "warning": "One or more cache keys could not be confirmed deleted (Redis may be degraded). The authoritative source of truth (database / chain) remains correct."
}
```

---

### Bulk-delete projections for multiple users

```
DELETE /api/v1/admin/cache/projections
Content-Type: application/json
{ "userIds": ["GBORROWER1…", "GBORROWER2…"] }
```

Maximum 100 subjects per request.

---

### Revoke projections (compliance)

```
POST /api/v1/admin/cache/projections/revoke
Content-Type: application/json
{ "userId": "GBORROWER…", "reason": "GDPR right-to-erasure request" }
```

Identical to DELETE but writes a `REVOKE cache/projections` audit record so compliance tools can filter these separately.

---

### Verify deletion

```
GET /api/v1/admin/cache/projections/:userId/verify
```

Read-only. Returns `verified: true` when no projection key survives in Redis.

---

## Audit Log Contract

Every deletion and revocation writes a row to `audit_logs` **before** the Redis keys are touched (so the record exists even if Redis is fully unreachable).

| Column | Value |
|---|---|
| `actor` | JWT `publicKey` or `INTERNAL_API_KEY` |
| `action` | `DELETE /cache/projections` or `REVOKE cache/projections` |
| `target` | `CacheProjections:{userId}` |
| `payload` | `{ subject, keysAttempted, outcome, schemaVersion }` |
| `ip_address` | Originating IP |
| `status` | 200 |

A second audit entry is written after the deletions complete, containing the per-key `outcome` map so the final success/failure is auditable independently.

For compliance queries, the new composite index `audit_logs_action_created_at_idx` makes filtering on `action` and `created_at` index-backed.

---

## Frontend Cache Invalidation Propagation

The backend sets `Cache-Invalidation-Token: projections:{userId}` on every successful deletion response. The token format is `projections:{userId}` for per-user evictions.

The frontend eviction module (`frontend/src/lib/projectionCacheEviction.ts`) reads this header and:

1. Calls `evictReadCacheByToken(token)` to remove matching entries from the in-process `apiClient` READ_CACHE map (the offline-fallback store).
2. Calls `invalidate.scores(queryClient, userId)` to mark all React Query score entries stale.
3. Calls `queryClient.invalidateQueries({ queryKey: ['loans'] })` to refresh borrower loan data.

This ensures that even a browser tab that has an in-memory cached response for the deleted user will not serve it after the deletion response is received.

---

## Authorization and Consent Requirements

| Operation | Required Auth | Notes |
|---|---|---|
| DELETE single | Admin JWT | Logged to `audit_logs` |
| DELETE bulk | Admin JWT | Logged per subject |
| POST revoke | Admin JWT | Logged with explicit reason |
| GET verify | Admin JWT | Read-only, no side effects |

No self-service deletion is exposed. Only principals with the `admin` role may invoke these endpoints, consistent with the existing admin guard in `jwtAuth.ts`.

---

## Failure Behavior

| Failure | Behavior |
|---|---|
| Redis unreachable | `cacheService.delete` returns `false`; response is `207`; audit entry records `false` for affected keys; no exception is thrown; DB/chain data is unaffected |
| Audit log DB write fails | Error is logged; deletion proceeds; a warning is emitted but the HTTP response is not degraded |
| Invalid `userId` | `400 Bad Request` returned before any Redis or DB operation |
| Duplicate call (idempotency) | `DEL` on a non-existent key is a no-op; second call returns the same response shape |
| Stale frontend entry | `Cache-Invalidation-Token` header triggers in-memory eviction in the browser |

---

## Migration Notes

**Migration `1809000000000_projection-deletion-audit-index.js`** adds:
- `audit_logs_action_created_at_idx` — composite index on `(action, created_at)` for compliance query performance
- `audit_logs_projection_deletion_idx` — partial index on `(actor, created_at)` filtered to projection deletion/revocation actions

No data migration required. No breaking schema changes.

---

## Validation Evidence

Run the following to reproduce all test cases:

```bash
# Backend unit + integration tests
cd backend && npm test -- --testPathPattern="projectionDeletion"

# Frontend unit tests
cd frontend && npm test -- --testPathPattern="projectionCacheEviction"
```

Expected: all tests pass. The test suite covers:
- Successful deletion path with per-key outcome assertions
- Idempotency (double-delete)
- Redis dependency failure (207 response)
- Access-control input validation (empty/oversized/invalid userId, oversized bulk batch)
- Audit log insertion with correct action strings
- Stale-serving prevention (verify returns `verified: true` after deletion)
- Frontend token parsing, userId extraction, React Query invalidation, in-memory cache eviction
