# Internal Request Signing

This document describes the HMAC-based request signing mechanism for internal service-to-service calls between RemitLend backend services.

## Overview

Internal routes reject unsigned requests to prevent unauthorized access from compromised frontends or external attackers. All internal service calls must include valid HMAC-SHA256 signatures with timestamps.

## Configuration

Set the signing secret in environment variables:

```bash
INTERNAL_SIGNING_SECRET=your-secure-random-secret-key-min-32-chars
```

**Recommendation:** Use a strong, random secret of at least 32 characters. Rotate periodically (see Key Rotation section).

## Signing Requests

### Headers Required

Every internal request must include:

- `x-remitlend-signature`: HMAC-SHA256 signature (hex-encoded)
- `x-remitlend-timestamp`: Unix timestamp (seconds) when the request was signed

### Signature Calculation

```
message = METHOD|PATH|BODY|TIMESTAMP
signature = HMAC-SHA256(message, secret).hex()
```

Example for `POST /api/internal/admin/emergency-pause`:

```
Method: POST
Path: /api/internal/admin/emergency-pause
Body: {"reason":"security-incident"}
Timestamp: 1724710000

Message to sign:
POST|/api/internal/admin/emergency-pause|{"reason":"security-incident"}|1724710000

Signature (with secret "my-secret-key"):
a1b2c3d4e5f6... (64 hex chars)
```

### Using Node.js

```typescript
import { getInternalRequestHeaders } from './middleware/internalRequestSigning.js';

const method = 'POST';
const path = '/api/internal/admin/emergency-pause';
const body = { reason: 'security-incident' };

const headers = getInternalRequestHeaders(method, path, body);

const response = await fetch(`https://api.remitlend.io${path}`, {
  method,
  headers: {
    'Content-Type': 'application/json',
    ...headers,
  },
  body: JSON.stringify(body),
});
```

### Using cURL

```bash
METHOD="POST"
PATH="/api/internal/admin/emergency-pause"
BODY='{"reason":"security-incident"}'
SECRET="my-secret-key"
TIMESTAMP=$(date +%s)

MESSAGE="${METHOD}|${PATH}|${BODY}|${TIMESTAMP}"
SIGNATURE=$(echo -n "$MESSAGE" | openssl dgst -sha256 -hmac "$SECRET" -hex | cut -d' ' -f2)

curl -X $METHOD \
  -H "Content-Type: application/json" \
  -H "x-remitlend-signature: $SIGNATURE" \
  -H "x-remitlend-timestamp: $TIMESTAMP" \
  -d "$BODY" \
  https://api.remitlend.io${PATH}
```

## Request Validation

The server validates:

1. **Headers present**: Both signature and timestamp headers must be provided
2. **Timestamp format**: Must be a valid Unix timestamp (seconds)
3. **Request freshness**: Timestamp must not be older than 5 minutes (300 seconds)
4. **Signature validity**: HMAC must match computed signature using current secret

**Rejected requests** return `401 Unauthorized` with an explanation message.

## Key Rotation Procedure

### Why Rotate?

- Security best practice: Limit exposure if a key is compromised
- Compliance: Many standards require periodic key rotation
- Operational readiness: Validate rotation process before emergencies

### When to Rotate

- **Minimum**: Every 90 days
- **On incident**: If a key is compromised
- **On change**: When personnel with access to the secret changes

### Rotation Steps

1. **Generate new secret**: Create a new cryptographically secure random string (min 32 chars)

2. **Deploy dual-secret support** (optional, for zero-downtime rotation):
   - Update application to accept both current and previous secret
   - Validate against both in sequence

3. **Update INTERNAL_SIGNING_SECRET**:
   ```bash
   # Update in secrets manager / environment configuration
   INTERNAL_SIGNING_SECRET=new-secret-key-here
   ```

4. **Redeploy services**:
   ```bash
   # Deploy backend with new secret
   kubectl set env deployment/remitlend-backend \
     INTERNAL_SIGNING_SECRET=new-secret-key-here
   ```

5. **Update client services**:
   - Update all internal clients (frontend, admin tools, automation)
   - Verify they can authenticate with new secret

6. **Monitor**:
   - Watch application logs for signature validation errors
   - Monitor `SIGTERM` from internal requests (should drop to zero)

7. **Decommission old secret**:
   - Remove from dual-secret support (if used)
   - Document rotation timestamp in security audit logs

### Validation

After rotation, verify internal requests work:

```bash
# Test internal endpoint (should succeed with new secret)
curl -X POST \
  -H "x-remitlend-signature: $(echo -n 'POST|...' | openssl dgst -sha256 -hmac 'new-secret-key' -hex | cut -d' ' -f2)" \
  -H "x-remitlend-timestamp: $(date +%s)" \
  https://api.remitlend.io/api/internal/admin/emergency-pause
```

## Debugging

### Signature Mismatch

If you get `401 Unauthorized - Invalid internal request signature`:

1. Verify the secret matches on both sides
2. Ensure the body JSON is formatted identically (no extra whitespace)
3. Check timestamp is fresh (within 5 minutes of server time)
4. Confirm headers are exactly: `x-remitlend-signature` and `x-remitlend-timestamp` (lowercase)

### Timestamp Outside Window

If you get `401 Unauthorized - Request timestamp outside acceptable window`:

1. Synchronize system clocks (NTP)
2. Ensure server and client time are within ±300 seconds
3. Check for clock skew on load balancers / proxies

### Missing Headers

If you get `401 Unauthorized - Missing internal request signature`:

1. Verify both `x-remitlend-signature` and `x-remitlend-timestamp` headers are sent
2. Check for header stripping by proxies or WAF
3. Ensure Content-Type is set if sending a body

## Internal Routes

Currently protected:

- `POST /api/internal/admin/emergency-pause` — Pause all contracts
- `POST /api/internal/admin/contract-state-update` — Update contract state

New internal routes should be added under `/api/internal/` prefix to ensure they receive signing middleware protection.
