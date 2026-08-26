# Idempotency Contract

## Overview

All write operations (POST, PUT, PATCH, DELETE) **require** an `Idempotency-Key` header. This ensures that duplicate requests—due to network timeouts, retries, or client bugs—return the same cached response without re-executing the operation.

## Specification

### Required Header

```
Idempotency-Key: <UUID or unique string>
```

- **Required for**: POST, PUT, PATCH, DELETE methods
- **Optional for**: GET, HEAD, OPTIONS methods
- **Format**: Any unique string (UUID v4 recommended)
- **Scope**: Global; key must be unique per operation
- **Lifetime**: 24 hours (cached responses expire after 24h)

### Request Example

```http
POST /api/v1/loans/request HTTP/1.1
Content-Type: application/json
Authorization: Bearer <token>
Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000

{
  "amount": 5000,
  "borrowerPublicKey": "GXXXXX..."
}
```

### Response Headers

**First request (cache miss):**
```
X-Idempotent-Replayed: false
X-Idempotency-Cache: MISS
```

**Subsequent identical requests (cache hit):**
```
X-Idempotent-Replayed: true
X-Idempotency-Cache: HIT
HTTP/1.1 200 OK
```

Returns **the exact same status code and response body** as the original request, even if it failed (4xx).

## Behavior

### Write Operations Always Require a Key

If you POST without an Idempotency-Key:
```json
{
  "error": "Idempotency-Key header is required for write operations"
}
```

### Duplicate Requests Return Cached Response

1. Client sends request with `Idempotency-Key: ABC`
2. Server executes the operation, caches the response
3. Client sends identical request with same key
4. Server returns cached response **without re-executing**
5. Response includes `X-Idempotent-Replayed: true`

### Cacheable Status Codes

- **2xx** (Success)
- **4xx** (Client errors, including validation failures)
- **NOT 5xx** (Server errors are never cached; client must retry)

### TTL and Expiration

- Cached responses expire after **24 hours**
- After 24h, a duplicate request with the same key is treated as a new request
- Each new request may result in a duplicate operation if keys collide

## Client Guidelines

### Generating Keys

Use a **UUID v4**:
```javascript
const key = crypto.randomUUID(); // Node.js
const key = uuidv4(); // JavaScript library
```

Or use a deterministic key for idempotent retries:
```javascript
const key = `${userId}-${operationType}-${timestamp}`;
```

### Error Handling

If you get a 5xx error (server crashed mid-request):
- **DO NOT reuse the same key**
- Generate a **new key** and retry
- The first request may have partially succeeded on-chain
- Use `rotateIdempotencyKey(oldKey, newKey)` or generate a fresh UUID

### Timeouts and Retries

```javascript
async function requestLoanWithIdempotency(amount, borrowerKey) {
  const idempotencyKey = crypto.randomUUID();
  const maxRetries = 3;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch('/api/v1/loans/request', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({ amount, borrowerPublicKey: borrowerKey }),
      });
      
      if (response.ok) {
        const data = await response.json();
        // Check if this is a cached replay
        const isReplayed = response.headers.get('X-Idempotent-Replayed') === 'true';
        console.log(`Request ${isReplayed ? 'replayed' : 'fresh'}`);
        return data;
      } else if (response.status >= 500) {
        // Server error: retry with new key after backoff
        // DO NOT reuse idempotencyKey on next attempt
        await sleep(2 ** attempt * 1000);
        continue; // Retry with same key may help if failure was transient
      } else {
        // Client error: don't retry
        throw new Error(await response.text());
      }
    } catch (error) {
      if (attempt < maxRetries - 1 && error.network) {
        await sleep(2 ** attempt * 1000);
        continue;
      }
      throw error;
    }
  }
}
```

## Key Rotation

If a request times out and you're unsure whether it succeeded on-chain:

1. Generate a **new Idempotency-Key**
2. Call `/admin/idempotency/rotate` (backend-only) to copy cached response from old key to new key
3. Retry with the new key

**Backend API:**
```typescript
import { rotateIdempotencyKey } from './middleware/idempotency.js';

const success = await rotateIdempotencyKey(oldKey, newKey);
if (success) {
  // Response copied; retry with newKey
}
```

## Enforcement Across All Write Operations

All routes implementing write operations **must** respect the idempotency contract:

- ✅ Loan requests, repayments, collateral operations
- ✅ Pool operations (deposits, withdrawals)
- ✅ Score transactions
- ✅ Remittance operations
- ✅ Admin operations (dispute resolution, verification)

The middleware is applied globally at the Express app level and enforces the requirement on all non-GET/HEAD/OPTIONS methods.

## Monitoring and Observability

**Logged on cache hits:**
```json
{
  "message": "Idempotency hit for key: ...",
  "url": "/api/v1/loans/request",
  "method": "POST"
}
```

**Metrics to track:**
- `idempotency_cache_hits` — duplicate requests served from cache
- `idempotency_cache_misses` — first-time requests executing
- `idempotency_key_missing_errors` — requests without required header

## Compliance Checklist

- [ ] All POST/PUT/PATCH/DELETE endpoints document Idempotency-Key requirement
- [ ] Clients generate unique keys per request (UUID v4 recommended)
- [ ] Clients check `X-Idempotent-Replayed` header to detect replayed responses
- [ ] Clients implement exponential backoff with **new keys** on 5xx errors
- [ ] Admin endpoints for dispute resolution and contract verification require keys
- [ ] Rate limiting is applied **before** idempotency caching (prevents abuse)
- [ ] Integration tests verify duplicate requests return 200 with same body
