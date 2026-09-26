# Webhook Consumer Certification Requirements

This document defines the minimum requirements a webhook consumer endpoint
must satisfy before being used in production with RemitLend. Meeting every
checkpoint below ensures reliable, secure, and observable webhook delivery.

See the [Webhook Integration Guide](webhooks.md) for subscription setup,
event payload shapes, and retry semantics. See
[`backend/docs/WEBHOOK_SIGNATURES.md`](../backend/docs/WEBHOOK_SIGNATURES.md)
for the HMAC signing specification.

---

## Table of Contents

- [Certification Levels](#certification-levels)
- [Level 1 — Connectivity](#level-1--connectivity)
- [Level 2 — Security](#level-2--security)
- [Level 3 — Reliability](#level-3--reliability)
- [Level 4 — Observability](#level-4--observability)
- [Level 5 — Load & Backpressure](#level-5--load--backpressure)
- [Certification Checklist](#certification-checklist)
- [Test Harness](#test-harness)
- [Threat Model Notes](#threat-model-notes)
- [Compatibility Impact](#compatibility-impact)
- [Rollout Steps](#rollout-steps)

---

## Certification Levels

Certification is progressive. Each level unlocks additional event volume or
reliability guarantees from the RemitLend platform.

| Level | Label | Minimum to reach production |
|-------|-------|----------------------------|
| 1 | Connectivity | ✅ Required |
| 2 | Security | ✅ Required |
| 3 | Reliability | ✅ Required |
| 4 | Observability | Recommended |
| 5 | Load & Backpressure | Required for high-volume subscriptions (> 100 events/min) |

---

## Level 1 — Connectivity

### 1.1 HTTPS only

The endpoint URL **must** use `https://`. HTTP endpoints are rejected at
subscription creation time.

### 1.2 TLS certificate validity

The server certificate must be issued by a publicly trusted CA, must not be
expired, and must match the subscription hostname. Self-signed certificates
are not accepted.

### 1.3 Endpoint reachability

The endpoint must be reachable from RemitLend's outbound IP ranges. Verify
with:

```bash
curl -X POST https://your-service.com/webhooks/remitlend \
  -H "Content-Type: application/json" \
  -d '{"test":true}' \
  -w "%{http_code}"
```

Expected: any 2xx status (your endpoint may reject malformed bodies, but must
not time out).

### 1.4 Response time ≤ 10 seconds

RemitLend marks a delivery attempt as failed if the endpoint does not respond
within **10 seconds**. Implement asynchronous processing — receive the event,
enqueue it, and respond `200` immediately.

---

## Level 2 — Security

### 2.1 HMAC signature verification

Every delivery includes an `X-RemitLend-Signature` header:

```
X-RemitLend-Signature: sha256=<hex-hmac>
```

Your endpoint **must** verify this header on every request using the
subscription secret returned at registration time. Use a timing-safe
comparison (`crypto.timingSafeEqual` in Node.js, `hmac.compare_digest` in
Python).

Requests that fail signature verification must be rejected with HTTP `401`.

Reference implementation (Node.js/Express):

```js
import crypto from "node:crypto";
import express from "express";

const app = express();

app.post(
  "/webhooks/remitlend",
  express.raw({ type: "application/json" }),
  (req, res) => {
    const sig = req.headers["x-remitlend-signature"] ?? "";
    const expected =
      "sha256=" +
      crypto
        .createHmac("sha256", process.env.REMITLEND_WEBHOOK_SECRET)
        .update(req.body)
        .digest("hex");

    const a = Buffer.from(expected);
    const b = Buffer.from(sig);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).send("Invalid signature");
    }

    const event = JSON.parse(req.body.toString());
    // enqueue event for async processing …
    res.sendStatus(200);
  }
);
```

### 2.2 No secret in URL

The subscription secret must never appear in the endpoint URL (query string
or path). Store it as an environment variable or secret manager entry.

### 2.3 Replay-window check

To prevent replay attacks, verify the `deliveredAt` timestamp in the payload
is within a **5-minute** window of your server clock:

```js
const deliveredAt = new Date(event.deliveredAt).getTime();
const now = Date.now();
if (Math.abs(now - deliveredAt) > 5 * 60 * 1000) {
  return res.status(400).send("Stale delivery");
}
```

### 2.4 Input validation

Parse and validate incoming JSON against the expected schema before
processing. Reject payloads that are missing required fields with HTTP `400`.
Do not pass unvalidated event data directly to downstream databases or
external services.

---

## Level 3 — Reliability

### 3.1 Idempotency on `deliveryId`

Every delivery includes a unique `deliveryId` field. Your endpoint must be
idempotent — processing the same `deliveryId` twice must produce the same
result and must not trigger duplicate side-effects (e.g. duplicate loan
disbursements).

Recommended pattern: store processed `deliveryId` values in a deduplication
table with a unique constraint and skip processing on conflict.

```sql
CREATE TABLE processed_webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

```js
await db.query(
  `INSERT INTO processed_webhook_deliveries (delivery_id)
   VALUES ($1) ON CONFLICT DO NOTHING`,
  [event.deliveryId]
);
```

### 3.2 Non-blocking response

Your handler must return a 2xx response **before** performing any slow
downstream operations (database writes, external API calls, email sends).
Use a job queue (e.g. BullMQ, SQS, Postgres-backed queue) to process the
event asynchronously.

### 3.3 Graceful handling of unknown event types

RemitLend may introduce new event types without prior notice. Your endpoint
must return `200` for any event type it does not recognise (to prevent
unnecessary retries) and log a warning for visibility.

```js
const KNOWN_EVENTS = new Set(["LoanApproved", "LoanRepaid", "LoanDefaulted"]);

if (!KNOWN_EVENTS.has(event.type)) {
  logger.warn("Unknown webhook event type received", { type: event.type });
  return res.sendStatus(200); // acknowledge and skip
}
```

### 3.4 Handling retries correctly

RemitLend retries failed deliveries with exponential backoff (up to
`max_attempts` configured on the subscription). Your endpoint must not assume
events arrive in order or exactly once. Design your processing logic for
at-least-once delivery semantics.

---

## Level 4 — Observability

### 4.1 Structured logging

Log every received delivery with at minimum:

| Field | Example |
|-------|---------|
| `deliveryId` | `"del_abc123"` |
| `eventType` | `"LoanRepaid"` |
| `processingMs` | `12` |
| `outcome` | `"success"` \| `"duplicate"` \| `"error"` |

### 4.2 Error alerting

Configure an alert if your webhook processor error rate exceeds 1 % over a
5-minute window. Common causes: schema drift, database unavailability,
downstream service timeouts.

### 4.3 Dead-letter queue

Failed events that exceed your internal retry budget must be moved to a
dead-letter queue (DLQ) for manual inspection. Do not silently discard events.

### 4.4 Lag monitoring

Track the delta between `event.occurredAt` and your processing timestamp.
Alert if processing lag exceeds **60 seconds** — this indicates queue backup.

---

## Level 5 — Load & Backpressure

### 5.1 Horizontal scaling

Ensure your endpoint can scale horizontally. Multiple replicas must share the
same deduplication store (the `processed_webhook_deliveries` table or
equivalent) to maintain idempotency.

### 5.2 Rate-limit handling

If your downstream system is rate-limited, return HTTP `429` or `503` to
signal RemitLend to back off. RemitLend's circuit breaker will pause delivery
to your endpoint after consecutive failures and resume with a probe request
after a cooldown period.

### 5.3 Load test baseline

Before enabling high-volume subscriptions run a synthetic load test
simulating 200 events/minute sustained for 5 minutes. Verify:

- p99 response time < 500 ms
- Error rate < 0.1 %
- No duplicate side-effects under concurrent delivery

---

## Certification Checklist

Copy and complete this checklist in your integration PR or go-live ticket.

```markdown
## Webhook Consumer Certification

### Level 1 — Connectivity
- [ ] Endpoint uses HTTPS with a publicly trusted certificate
- [ ] Endpoint responds within 10 seconds
- [ ] Endpoint is reachable from RemitLend outbound IPs

### Level 2 — Security
- [ ] HMAC signature verification implemented with timing-safe compare
- [ ] Subscription secret stored in secret manager / env var (not in URL)
- [ ] Replay-window check (reject deliveries older than 5 minutes)
- [ ] Input validation rejects malformed payloads with 400

### Level 3 — Reliability
- [ ] Idempotency implemented using `deliveryId` deduplication
- [ ] Response returned immediately; processing is async
- [ ] Unknown event types return 200 and log a warning
- [ ] Processing logic tolerates out-of-order and duplicate events

### Level 4 — Observability
- [ ] Structured logs include deliveryId, eventType, processingMs, outcome
- [ ] Error-rate alert configured
- [ ] Dead-letter queue in place for exhausted retries
- [ ] Processing-lag monitoring in place

### Level 5 — Load (if > 100 events/min)
- [ ] Horizontal scaling tested with shared deduplication store
- [ ] 429/503 responses implemented for backpressure signalling
- [ ] Load test run at target throughput with < 0.1 % error rate
```

---

## Test Harness

Use the RemitLend local development environment to emit test deliveries:

```bash
# Start all services
docker compose up --build

# Send a synthetic LoanRepaid event to your local endpoint
curl -X POST http://localhost:3001/api/webhooks/test \
  -H "Authorization: Bearer <your-jwt>" \
  -H "Content-Type: application/json" \
  -d '{
    "subscriptionId": "sub_abc123",
    "eventType": "LoanRepaid"
  }'
```

The Swagger UI at `http://localhost:3001/docs` provides an interactive version
of the above under **POST /api/webhooks/test**.

For signature verification testing, use `backend/docs/WEBHOOK_SIGNATURES.md`
which includes example raw bodies and expected HMAC values.

---

## Threat Model Notes

| Threat | Mitigation |
|--------|-----------|
| Forged payloads from a third party | HMAC signature verification (Level 2.1) |
| Replay of a genuine delivery | Replay-window check + `deliveryId` deduplication |
| Subscription secret leakage via logs | Secret stored in env/secret manager; never logged |
| Denial-of-service via high event volume | Circuit breaker on RemitLend side; backpressure signals on consumer side |
| Man-in-the-middle interception | TLS required; certificate validation enforced |
| Cascade failure if consumer is slow | Async processing; immediate 2xx response |

---

## Compatibility Impact

This document is additive and does not change any existing API or contract.
Existing subscriptions that do not yet implement all certification requirements
continue to work — the requirements are a go-live gate, not an enforcement
mechanism on the platform side.

Future platform versions may enforce Level 2 (HMAC verification) as mandatory
at the API layer by rejecting subscriptions on non-HTTPS URLs (already done)
or by revoking subscriptions with persistent signature-check failures.

---

## Rollout Steps

1. Share this document with the integration team before they begin
   implementation.
2. Use the checklist in the integration PR as a review gate.
3. Perform a load test (Level 5) at least one week before go-live.
4. After go-live, monitor delivery success rate and processing lag for 48 hours.
5. Schedule a post-go-live review at 30 days to confirm the DLQ is empty and
   error rate is within bounds.
