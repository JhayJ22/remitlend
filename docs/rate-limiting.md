# Distributed Rate Limiting

## Overview

The backend uses a **distributed Redis sliding window** rate limiter to enforce limits across all instances. This ensures consistent rate limiting regardless of how traffic is routed.

## Architecture

### Sliding Window Algorithm

Each endpoint maintains a **sorted set** in Redis, keyed by user/IP:

```
ratelimit:user-123 = {
  1690000000000: request_1,
  1690000001000: request_2,
  1690000005000: request_3,
  ...
}
```

When a request arrives:

1. **Remove old entries** — delete all timestamps outside the window
2. **Count remaining** — requests still within window
3. **Allow or deny** — if count < max, allow; else return 429
4. **Add new entry** — record this request's timestamp

**Benefit:** Accurate counting without memory bloat; old entries auto-expire via Redis TTL.

## Rate Limit Headers

Every response includes three headers:

```http
RateLimit-Limit: 50
RateLimit-Remaining: 42
RateLimit-Reset: 1690000060
```

- `Limit`: max requests per window
- `Remaining`: requests left in current window
- `Reset`: Unix timestamp when window resets (oldest request + windowMs)

When rate-limited (429), also includes:

```http
Retry-After: 12
```

Client should retry after 12 seconds.

## Default Limits

| Endpoint | Limit | Window |
|----------|-------|--------|
| Global (all IPs) | 100 | 15 min |
| Per-user operations | 50 | 1 min |
| Loan operations | 20 | 1 min |
| Auth (login, challenge) | 10 | 1 min |
| Simulation endpoints | 5 | 1 min |

## Response Codes

### 200 (Success)

```json
{
  "data": { ... },
  "RateLimit-Remaining": "49"
}
```

### 429 (Too Many Requests)

```json
{
  "error": "Rate limit exceeded. Retry after 12 seconds.",
  "statusCode": 429,
  "errorCode": "RATE_LIMIT_EXCEEDED"
}
```

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 12
RateLimit-Limit: 50
RateLimit-Remaining: 0
RateLimit-Reset: 1690000060
```

## Client Implementation

### Respecting Rate Limits

```javascript
async function fetchWithRateLimit(url, options) {
  const response = await fetch(url, options);
  
  if (response.status === 429) {
    const retryAfter = response.headers.get('Retry-After');
    const delayMs = (parseInt(retryAfter) || 60) * 1000;
    
    console.log(`Rate limited. Retrying in ${delayMs}ms`);
    await new Promise(r => setTimeout(r, delayMs));
    
    // Retry the request
    return fetchWithRateLimit(url, options);
  }
  
  return response;
}
```

### Proactive Rate Limit Avoidance

```javascript
// Read headers to slow down if approaching limit
const remaining = response.headers.get('RateLimit-Remaining');
if (remaining < 5) {
  console.warn('Approaching rate limit. Backing off.');
  await delay(1000);
}
```

### Batch Operations

Instead of individual requests, batch operations when possible:

```javascript
// BEFORE: 100 individual loan detail requests
const loans = await Promise.all(
  loanIds.map(id => fetch(`/api/v1/loans/${id}`))
);

// AFTER: Fetch all in a single batch endpoint (if available)
const loans = await fetch('/api/v1/loans/batch', {
  method: 'POST',
  body: JSON.stringify({ loanIds })
});
```

## Admin Operations

### Checking Current Limits

Redis-backed limits are queryable for monitoring:

```bash
# Check current request count for a user
ZCARD ratelimit:user-123
# Output: 5

# Check all active rate limit keys
KEYS ratelimit:*
# Output: ratelimit:user-123, ratelimit:192.168.1.1, ...

# Check expiry
TTL ratelimit:user-123
# Output: 32 (seconds until auto-cleanup)
```

### Resetting a User's Limit

```bash
DEL ratelimit:user-123
# User can now make requests again immediately
```

### Monitoring

Export rate limit metrics from Redis:

```bash
# Total active rate limit tracked keys
DBSIZE

# Memory used by rate limiting
INFO memory
# Look for used_memory (total) vs specific key sizes
```

## Kubernetes Configuration

### Resources Required

Redis must handle:

```
Max users/IPs * requests_per_window = sorted set size
Example: 100k users * 50 requests = ~5-10MB typical
```

### Redis Persistence

For production, enable Redis persistence:

```yaml
redis:
  persistence:
    enabled: true
    storageClassName: fast-ssd
    size: 10Gi
```

Rate limit data is transient (expires hourly), but persistence helps recovery after crashes.

### Monitoring Alerts

```yaml
alerts:
  - name: HighRateLimitRejections
    expr: rate(rate_limit_429[5m]) > 0.1
    annotations:
      summary: "High 429 error rate"
      action: "Check if users are abusing or if limits too strict"
  
  - name: RedisMemoryHigh
    expr: redis_memory_used_bytes / redis_memory_max_bytes > 0.8
    annotations:
      summary: "Redis memory pressure"
      action: "Increase Redis memory or adjust rate limits"
```

## Adjusting Limits

### For a Specific User

Manually adjust via admin API (future feature):

```http
PATCH /api/v1/admin/rate-limits/user-123
Content-Type: application/json

{
  "limit": 100,
  "windowMinutes": 1
}
```

Currently requires code change to `distributedRateLimiter.ts`.

### For All Users (Deployment)

Edit the source and redeploy:

```typescript
export const createPerUserRateLimiter = () =>
  new DistributedRateLimiter({
    max: 50,  // Change here
    windowMs: 60 * 1000,
    keyGenerator: ...
  });
```

## Testing Rate Limits

### Load Test

```bash
# Hit an endpoint 60 times in 1 minute (exceeds 50/min limit)
for i in {1..60}; do
  curl -H "Authorization: Bearer $TOKEN" \
       http://localhost:3001/api/v1/loans/$i/details \
       -w "\nStatus: %{http_code}\n"
  sleep 1
done

# After ~50 requests, should see:
# Status: 429
# Retry-After: X
```

### Debug Rate Limit State

```bash
# Connect to Redis
redis-cli

# List all current rate limit keys
> KEYS ratelimit:*

# Check a specific user's request count
> ZCARD ratelimit:user-123

# View timestamps
> ZRANGE ratelimit:user-123 0 -1 WITHSCORES
```

## Distributed Instance Behavior

### Scenario: Two instances, one user

```
Request 1 → Instance A (ratelimit:user-123 = 1)
Request 2 → Instance B (ratelimit:user-123 = 2)  [shared Redis]
Request 3 → Instance A (ratelimit:user-123 = 3)  [all see same count]
Request 51 → Instance B → 429 Rate Limited
```

All instances see the same counter via shared Redis.

### Failover Behavior

If Redis goes down:

```typescript
// From distributedRateLimiter.ts
catch (error) {
  // Fail open: allow request if Redis is down
  return {
    allowed: true,
    limit: this.max,
    remaining: this.max,
    resetAfter: now + this.windowMs,
  };
}
```

**Policy:** If Redis is unavailable, rate limits are **not enforced** (fail-safe). Limits resume once Redis recovers.

## Compliance Checklist

- [ ] Rate limit headers sent with every response
- [ ] 429 responses include Retry-After header
- [ ] Limits enforced across all instances (Redis backed)
- [ ] Admin can monitor active rate limit keys
- [ ] Alerts configured for high 429 rates
- [ ] Clients implement exponential backoff on 429
- [ ] Load tests pass under expected traffic
- [ ] Redis is configured for production (persistence, memory limits)
