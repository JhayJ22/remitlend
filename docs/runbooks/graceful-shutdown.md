# Graceful Shutdown Runbook

## Overview

The backend implements graceful shutdown to ensure zero dropped requests during deployments or restarts. When SIGTERM/SIGINT is received:

1. Stop accepting new requests (return 503 Service Unavailable)
2. Wait for in-flight requests to complete (with 30s timeout)
3. Stop background schedulers
4. Close event streams
5. Drain database connection pool
6. Exit cleanly

## Deployment Flow

### Kubernetes / Container Orchestration

The shutdown process is triggered by SIGTERM when a pod is terminated:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: backend
spec:
  containers:
  - name: backend
    image: remitlend:latest
    lifecycle:
      preStop:
        exec:
          command: ["/bin/sh", "-c", "sleep 15"]  # Optional: wait for load balancer to stop routing
  terminationGracePeriodSeconds: 45  # Must be > 30s (shutdown timeout) + buffer
```

### Sequence of Events

```
T=0s   — kubectl terminate pod / docker stop
        SIGTERM sent to PID 1 (Node process)

T=1s   — Shutdown handler sets isShuttingDown = true
        New HTTP requests return 503 immediately
        In-flight requests complete

T=15s  — All in-flight requests have completed
        Schedulers stop (indexer, score decay, etc.)
        Event streams close

T=22s  — Database pool drained
        Redis connection closes

T=22s  — Process exits with code 0

T=45s  — [Safety timeout] Process force-killed if still running
```

## Monitoring

### Log Messages

During shutdown, you'll see:

```
SIGTERM signal received: initiating graceful shutdown
Shutdown initiated. Stopping new requests.
In-flight requests drained or timeout reached.
Stopping background schedulers...
All schedulers stopped.
Closing HTTP server...
HTTP server closed.
Draining database pool...
Database pool drained.
Closing Redis connection...
Graceful shutdown completed successfully.
```

### Request Rejection During Shutdown

New requests during shutdown receive:

```http
HTTP/1.1 503 Service Unavailable
Content-Type: application/json

{
  "error": "Server is shutting down",
  "message": "Please retry after the server restarts"
}
```

Clients implementing exponential backoff will automatically retry after the server comes back up.

## Edge Cases

### In-Flight Request Timeout

If a request takes longer than 30 seconds to complete:

```
Shutdown timeout: 5 requests still active after 30s
Graceful shutdown exceeded 30s, forcing exit.
```

The process exits anyway. Long-running requests are forcibly closed.

**Prevention:**
- Set request timeouts on resource-intensive endpoints
- Implement query timeouts in database operations
- Use `AbortController` for HTTP requests with timeout

### Database Pool Not Draining

If database connections won't close:

```
Error draining database pool: context deadline exceeded
```

The process waits only for active requests, then closes connections forcibly.

### Stalled Scheduler

If a scheduler doesn't stop cleanly:

```
Timeout waiting for indexer to stop
```

The process continues anyway—forceful exit after 30s ensures the pod terminates.

## Testing Graceful Shutdown Locally

```bash
# Terminal 1: Start backend
npm run dev

# Terminal 2: Send SIGTERM after requests are in progress
# (Wait a few seconds, then...)
kill -TERM <pid>

# Observe logs:
# - New requests return 503
# - In-flight requests complete
# - Shutdown occurs cleanly within ~25s
```

### Load Test During Shutdown

```bash
# Terminal 1: Start backend
npm run dev

# Terminal 2: Generate traffic
watch -n 0.5 'curl http://localhost:3001/health'

# Terminal 3: Trigger shutdown
kill -TERM <pid>

# Expected: requests in progress complete; new requests return 503
```

## Kubernetes Probes

**Liveness Probe** (should NOT fail during shutdown):

```yaml
livenessProbe:
  httpGet:
    path: /health
    port: 3001
  initialDelaySeconds: 5
  periodSeconds: 10
  timeoutSeconds: 5
  failureThreshold: 3
```

**Readiness Probe** (should fail during shutdown):

```yaml
readinessProbe:
  httpGet:
    path: /health
    port: 3001
  initialDelaySeconds: 2
  periodSeconds: 5
  timeoutSeconds: 5
  failureThreshold: 1
```

During shutdown, the readiness probe will fail, and the service will immediately stop routing new requests to this instance. In-flight requests complete within the gracePeriod.

## Connection Pool Draining

### PostgreSQL

The database pool enforces a connection drain:

```typescript
await closePool();
// - Waits for active queries to complete
// - Closes idle connections
// - Closes the pool
// - Times out after connectionTimeoutMillis
```

### Redis

```typescript
await cacheService.close();
// - Closes the Redis client
// - Flushes pending commands
```

## Scaling Considerations

### Multiple Instances

With load balancer (e.g., Kubernetes Service):

```
Instance A receives SIGTERM
  ↓
Readiness probe fails (503 health check)
  ↓
Load balancer removes from rotation
  ↓
Existing requests drain
  ↓
Instance A exits
  ↓
New traffic routes to Instances B, C, D
```

Result: **Zero dropped requests** (during normal deployment)

### High-Concurrency Scenarios

If you have 1000 concurrent requests and gracePeriod is 30s:

1. SIGTERM received
2. Readiness probe fails, load balancer drains
3. New requests blocked locally (503)
4. In-flight: 1000 requests complete within 30s
5. If any take longer: forceful close (may drop those)

**Fix:** Increase `terminationGracePeriodSeconds` in Kubernetes manifest.

## Deployment Checklist

- [ ] `terminationGracePeriodSeconds >= 45` in Kubernetes manifests
- [ ] Readiness probe returns 503 during shutdown
- [ ] Load balancer respects readiness probe
- [ ] Database pool connections have reasonable query timeouts
- [ ] Redis client has connection timeout set
- [ ] No background jobs that ignore shutdown signals
- [ ] Monitoring alerts configured for shutdown errors
- [ ] Tested graceful shutdown in staging before production

## Troubleshooting

### Pod Hangs During Termination

**Symptom:** kubectl delete pod hangs; pod doesn't exit after ~45s

**Check:**
```bash
kubectl describe pod <name>
# Look for "State.Waiting.Reason"
```

**Debug:**
```bash
# Check logs during termination
kubectl logs <name> -f

# If still running after 45s, something is preventing exit
# Check for open file handles, subprocess children, etc.
```

**Fix:**
- Increase `terminationGracePeriodSeconds`
- Check for blocking scheduler tasks
- Ensure database connections timeout

### 503 During Shutdown Not Honored

**Symptom:** Requests still succeed after SIGTERM

**Cause:** Load balancer not respecting readiness probe

**Fix:**
```yaml
readinessProbe:
  httpGet:
    path: /health
    port: 3001
  failureThreshold: 1  # Fail immediately on first 503
  periodSeconds: 2    # Check frequently
```

### Scheduler Not Stopping

**Symptom:** IndexerManager or score decay scheduler hangs

**Check logs for:**
```
Error in indexer during shutdown
Timeout waiting for indexer to stop
```

**Fix:**
- Ensure scheduler has timeout logic
- Check for deadlocks in database queries
- Verify Redis connection doesn't hang

## Performance Impact

Graceful shutdown has **negligible performance overhead**:

- Shutdown middleware: ~1μs per request (just a counter increment)
- No additional database queries
- No additional Redis calls
- Shutdown logic only runs on SIGTERM (rare event)

## Related Configuration

Environment variables:

```bash
# Shutdown timeout (hardcoded to 30s in code)
# Edit src/index.ts to change
DEFAULT_SHUTDOWN_TIMEOUT_MS=30000

# Database connection timeout
DB_CONNECTION_TIMEOUT_MS=5000
```

## Further Reading

- [Node.js Signal Handling](https://nodejs.org/en/docs/guides/graceful-shutdown/)
- [Kubernetes Pod Lifecycle](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/)
- [Express Graceful Shutdown Best Practices](https://expressjs.com/)
