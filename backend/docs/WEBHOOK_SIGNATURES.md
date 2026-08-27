# Webhook Signature Verification with Rotating Secrets

This document describes RemitLend's webhook signing mechanism to prevent unauthorized webhook injection and ensure payload authenticity.

## Overview

All RemitLend webhooks are signed with HMAC-SHA256. Each subscriber has a unique rotating secret that is rotated on a schedule. Verifying the signature ensures:

1. **Authenticity**: The webhook came from RemitLend
2. **Integrity**: The payload has not been tampered with
3. **Replay prevention**: Timestamps prevent replaying old webhooks

## Webhook Signature Format

### Headers

Every RemitLend webhook includes two signature headers:

| Header | Format | Example |
|--------|--------|---------|
| `x-remitlend-signature` | HMAC-SHA256 (hex) | `a1b2c3d4e5f6...` (64 chars) |
| `x-remitlend-timestamp` | Unix timestamp (seconds) | `1724710000` |

### Signature Calculation

```
message = PAYLOAD.TIMESTAMP
signature = HMAC-SHA256(message, secret).hex()
```

Example:

```
Payload: {"event":"loan.created","loanId":"loan_123","amount":1000}
Timestamp: 1724710000
Secret: your-webhook-secret-key

Message to verify:
{"event":"loan.created","loanId":"loan_123","amount":1000}.1724710000

Signature (hex):
a1b2c3d4e5f6789abcdef0123456789a1b2c3d4e5f6789abcdef0123456789
```

## Verifying Signatures

### Node.js

```typescript
import crypto from 'crypto';

function verifyWebhookSignature(
  payload: string,
  timestamp: string,
  signature: string,
  secret: string,
): boolean {
  const message = `${payload}.${timestamp}`;
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(message)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expectedSignature, 'hex'),
    );
  } catch {
    return false;
  }
}

app.post('/webhooks/events', express.json(), (req, res) => {
  const signature = req.headers['x-remitlend-signature'];
  const timestamp = req.headers['x-remitlend-timestamp'];
  const secret = process.env.WEBHOOK_SECRET;

  if (!signature || !timestamp) {
    return res.status(400).json({ error: 'Missing signature headers' });
  }

  // Verify timestamp is fresh (within 5 minutes)
  const now = Math.floor(Date.now() / 1000);
  const age = now - parseInt(timestamp as string, 10);
  if (age < 0 || age > 300) {
    return res.status(401).json({ error: 'Stale timestamp' });
  }

  // Get raw body for signature verification (before JSON parsing)
  const rawBody = req.rawBody; // Must be preserved by middleware
  const isValid = verifyWebhookSignature(
    rawBody,
    timestamp as string,
    signature as string,
    secret,
  );

  if (!isValid) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // Process webhook
  const event = req.body;
  console.log('Webhook verified:', event);
  res.json({ ok: true });
});
```

### Python

```python
import hmac
import hashlib
import json
from flask import request

def verify_webhook_signature(payload_str, timestamp, signature, secret):
    message = f"{payload_str}.{timestamp}".encode()
    expected_sig = hmac.new(
        secret.encode(), message, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(signature, expected_sig)

@app.route('/webhooks/events', methods=['POST'])
def handle_webhook():
    signature = request.headers.get('x-remitlend-signature')
    timestamp = request.headers.get('x-remitlend-timestamp')
    secret = os.environ['WEBHOOK_SECRET']

    if not signature or not timestamp:
        return {'error': 'Missing signature'}, 400

    # Verify timestamp freshness
    now = int(time.time())
    age = now - int(timestamp)
    if age < 0 or age > 300:
        return {'error': 'Stale timestamp'}, 401

    # Get raw body (before JSON parsing)
    raw_body = request.get_data(as_text=True)
    
    if not verify_webhook_signature(raw_body, timestamp, signature, secret):
        return {'error': 'Invalid signature'}, 401

    # Process webhook
    event = request.json
    print(f"Webhook verified: {event}")
    return {'ok': True}
```

### cURL (for testing)

```bash
#!/bin/bash

PAYLOAD='{"event":"loan.created","loanId":"loan_123"}'
SECRET="your-webhook-secret-key"
TIMESTAMP=$(date +%s)

MESSAGE="${PAYLOAD}.${TIMESTAMP}"
SIGNATURE=$(echo -n "$MESSAGE" | openssl dgst -sha256 -hmac "$SECRET" -hex | cut -d' ' -f2)

curl -X POST \
  -H "Content-Type: application/json" \
  -H "x-remitlend-signature: $SIGNATURE" \
  -H "x-remitlend-timestamp: $TIMESTAMP" \
  -d "$PAYLOAD" \
  https://yourapp.example.com/webhooks/events
```

## Secret Rotation

RemitLend automatically rotates webhook secrets on a schedule. Your integration should support secret rotation without downtime.

### Rotation Flow

1. **New secret generated**: RemitLend creates a new secret and marks it as active
2. **Old secret remains valid**: Previous secrets continue to verify for a grace period
3. **Webhooks signed with new secret**: All new webhooks use the latest secret
4. **Old secret deprecated**: After grace period, old secrets no longer accept webhooks

### Handling Rotation

**Option 1: Automatic rotation (Recommended)**

Store multiple secrets and attempt verification against all of them:

```typescript
async function verifyWebhookWithRotation(
  payload: string,
  timestamp: string,
  signature: string,
  subscriberId: string,
): Promise<boolean> {
  // Get all active secrets for this subscriber
  const secrets = await getActiveSecretsForSubscriber(subscriberId);
  
  // Try verification against each secret
  for (const secret of secrets) {
    if (verifyWebhookSignature(payload, timestamp, signature, secret)) {
      return true;
    }
  }
  
  return false;
}
```

**Option 2: Poll RemitLend API**

Periodically fetch the current webhook secret from RemitLend's API:

```typescript
async function refreshWebhookSecret() {
  const response = await fetch(
    'https://api.remitlend.io/api/v1/webhooks/secret',
    {
      headers: { 'Authorization': `Bearer ${apiToken}` }
    }
  );
  const data = await response.json();
  process.env.WEBHOOK_SECRET = data.secret;
}

// Refresh every 30 minutes
setInterval(refreshWebhookSecret, 30 * 60 * 1000);
```

### Rotation Monitoring

Monitor webhook verification failures to detect rotation issues:

```typescript
app.post('/webhooks/events', (req, res) => {
  try {
    if (!verifyWebhookSignature(...)) {
      logger.warn('Webhook verification failed', {
        timestamp: req.headers['x-remitlend-timestamp'],
        subscriberId: req.headers['x-subscriber-id'],
        failure_type: 'invalid_signature',
      });
      return res.status(401).json({ error: 'Invalid signature' });
    }
  } catch (error) {
    logger.error('Webhook verification error', { error });
    return res.status(500).json({ error: 'Internal server error' });
  }
  
  // Process webhook...
});
```

## Webhook Events

### Supported Events

RemitLend sends webhooks for these events:

| Event | Payload | When |
|-------|---------|------|
| `loan.created` | Loan object, created_at timestamp | Loan created on-chain |
| `loan.approved` | Loan ID, approved_at timestamp | Loan approved |
| `loan.rejected` | Loan ID, rejection_reason | Loan rejected |
| `loan.disbursed` | Loan ID, amount, disbursed_at | Funds disbursed |
| `loan.repaid` | Loan ID, amount, repaid_at | Loan repaid on-chain |
| `pool.created` | Pool object | Pool created |
| `pool.deposit` | Pool ID, amount, depositor | Deposit received |
| `pool.withdrawal` | Pool ID, amount, withdrawer | Withdrawal processed |
| `score.updated` | User ID, new_score, previous_score | Credit score changed |

### Example Payloads

**loan.created:**
```json
{
  "event": "loan.created",
  "eventId": "evt_abc123",
  "timestamp": 1724710000,
  "data": {
    "loanId": "loan_123",
    "borrowerId": "user_456",
    "amount": 50000,
    "currency": "USD",
    "term": 12,
    "status": "active",
    "createdAt": "2026-08-26T12:00:00Z"
  }
}
```

**loan.repaid:**
```json
{
  "event": "loan.repaid",
  "eventId": "evt_def456",
  "timestamp": 1724720000,
  "data": {
    "loanId": "loan_123",
    "borrowerId": "user_456",
    "amount": 50000,
    "currency": "USD",
    "paidAt": "2026-08-26T13:00:00Z"
  }
}
```

## Webhook Endpoints

### Registering Webhooks

```bash
curl -X POST https://api.remitlend.io/api/v1/webhooks \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://yourapp.example.com/webhooks/events",
    "events": ["loan.created", "loan.repaid"],
    "description": "Production loan event notifications"
  }'
```

### Rotating Webhook Secret

```bash
curl -X POST https://api.remitlend.io/api/v1/webhooks/secret/rotate \
  -H "Authorization: Bearer YOUR_API_KEY"

# Returns:
{
  "secret": "new_secret_hex_string",
  "activatedAt": "2026-08-26T12:00:00Z",
  "previousSecretExpiredAt": "2026-08-27T12:00:00Z"
}
```

### Listing Webhooks

```bash
curl https://api.remitlend.io/api/v1/webhooks \
  -H "Authorization: Bearer YOUR_API_KEY"

# Returns array of webhook subscriptions
```

### Deleting Webhooks

```bash
curl -X DELETE https://api.remitlend.io/api/v1/webhooks/webhook_123 \
  -H "Authorization: Bearer YOUR_API_KEY"
```

## Webhook Delivery Guarantees

### At-Least-Once Delivery

RemitLend guarantees **at-least-once** delivery:

- Webhooks are retried on failure
- Retry delays: 5 min, 15 min, 45 min (exponential backoff)
- Failed webhooks logged in admin dashboard

### Deduplication

Your endpoint should handle duplicate webhooks (same `eventId`):

```typescript
// Database-backed deduplication
async function handleWebhook(event) {
  const existing = await db.webhookEvents.findOne({ eventId: event.eventId });
  
  if (existing) {
    logger.info('Webhook already processed', { eventId: event.eventId });
    return res.json({ ok: true }); // Idempotent success
  }
  
  // Process event and store eventId
  await processLoanCreated(event.data);
  await db.webhookEvents.create({ eventId: event.eventId, processed_at: new Date() });
  
  res.json({ ok: true });
}
```

## Debugging

### Test Webhook Delivery

Use the admin dashboard or CLI to send a test webhook:

```bash
remitlend webhooks test --subscriber-id subscriber_123 --event loan.created
```

### Verify Signature Locally

```bash
# Extract and verify the signature
curl -s -v https://yourapp.example.com/webhooks/events 2>&1 | grep -E "x-remitlend"

# Calculate expected signature
echo -n '{"event":"test"}.1724710000' | \
  openssl dgst -sha256 -hmac "your-webhook-secret" -hex
```

### Common Issues

**Signature verification fails:**
- Ensure raw body is used (before JSON parsing)
- Check secret is correct and URL-encoded if necessary
- Verify timestamp is fresh (within 5 minutes)
- Confirm JSON is formatted identically (no extra whitespace)

**Timestamp mismatch:**
- Synchronize server time with NTP
- Check for clock skew between services

**Webhooks not received:**
- Check webhook URL is accessible from the internet
- Verify firewall allows POST from RemitLend's IP ranges
- Enable webhook logs in admin dashboard

## Security Best Practices

1. **Store secrets securely**: Use environment variables or secrets manager
2. **Never log secrets**: Avoid printing webhook secrets in logs
3. **Validate schema**: Ensure webhook payload matches expected format
4. **Rate limit**: Throttle webhook processing if needed
5. **Fail open**: Return 200 OK even if processing fails; retry later
6. **Monitor**: Alert on unusual webhook volumes or repeated failures

## SDK Support

### Official SDKs

```typescript
// JavaScript
import { RemitLend } from '@remitlend/webhook-sdk';
const sdk = new RemitLend({ webhookSecret: process.env.WEBHOOK_SECRET });
const isValid = sdk.verifyWebhookSignature(req);
```

```python
# Python
from remitlend import webhooks
is_valid = webhooks.verify_signature(
    payload=request.data,
    signature=request.headers.get('x-remitlend-signature'),
    timestamp=request.headers.get('x-remitlend-timestamp'),
    secret=os.environ['WEBHOOK_SECRET']
)
```

## References

- [HMAC in cryptography](https://en.wikipedia.org/wiki/HMAC)
- [Webhook best practices](https://webhook.guide/)
- [RemitLend Webhook API Docs](https://docs.remitlend.io/webhooks)
