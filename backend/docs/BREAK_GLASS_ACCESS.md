# Break-Glass Production Access

> **Issue #849** — Formalized emergency production access with ticketed reason, independent approval, least privilege, time limit, automatic expiry, alerting, and immutable audit trail.

## Purpose

Break-glass access is an emergency measure for situations where normal access controls would prevent a time-critical remediation. This feature enforces a strict lifecycle that satisfies every requirement in issue #849:

| Requirement | Enforcement |
|---|---|
| Ticketed reason | `ticket_ref` field is mandatory; request is rejected if empty |
| Minimum justification | `reason` must be ≥ 20 characters |
| Independent approval | Approver must be a different admin wallet (DB CHECK + app guard) |
| Least privilege | Requested scopes must be from an explicit allowlist; approver may grant a strict subset |
| Time limit | `durationSeconds` is mandatory; maximum configurable via `BREAK_GLASS_MAX_DURATION_HOURS` |
| Automatic revocation | Expiry scheduler revokes active grants every 60 s |
| Alerting | Every lifecycle event fires a structured log alert and optional webhook POST |
| Immutable audit trail | `break_glass_grants` core evidence columns are protected by a PL/pgSQL trigger |

---

## State machine

```
                       POST /break-glass
                             │
                         pending
                        /       \
           POST /approve         POST /deny   (different admin)
                │                     │
            approved               denied ◄── terminal
                │
           POST /activate   (requester only)
                │
             active
            /       \
  expiry sweep       POST /revoke   (any admin)
       │                   │
    expired ◄── terminal  revoked ◄── terminal
```

**Terminal states**: `denied`, `expired`, `revoked` — no further transitions are possible.

**Expiry clock** starts at **activation**, not at approval. The approver and requester have flexibility in timing the activation within the approval window.

---

## Allowed scopes

Grants may only cover these scopes (defined in `BREAK_GLASS_ALLOWED_SCOPES`):

```
read:loans          write:loans
read:score          read:remittances
read:webhooks       admin:indexer
admin:reconciliation admin:loans
admin:disputes
```

`admin:all` is explicitly excluded. No break-glass grant can elevate a requester to full admin scope.

---

## Schema

### New table: `break_glass_grants`

```sql
id               bigserial PRIMARY KEY
ticket_ref       varchar(128) NOT NULL            -- external audit anchor (INC-1234)
reason           text NOT NULL                    -- ≥ 20 chars justification
requester        varchar(56) NOT NULL             -- Stellar public key
approver         varchar(56)                      -- set on approve/deny; must ≠ requester
requested_scopes text[] NOT NULL                 -- what was asked for
granted_scopes   text[]                           -- what was actually granted (subset)
state            varchar(16) NOT NULL DEFAULT 'pending'
                 CHECK IN (pending, approved, active, denied, expired, revoked)
duration_seconds integer NOT NULL
expires_at       timestamptz                      -- set at activation time
approved_at      timestamptz
activated_at     timestamptz
revoked_at       timestamptz
revoked_by       varchar(56)
revocation_reason text
denied_at        timestamptz
denial_reason    text
expired_at       timestamptz
alert_sent_at    timestamptz                      -- NULL = alert not yet sent
alert_channels   text[]                           -- e.g. ['log','webhook']
created_at       timestamptz NOT NULL DEFAULT NOW()
updated_at       timestamptz NOT NULL DEFAULT NOW()
```

**DB-level constraints:**
- `break_glass_distinct_principals`: `approver IS NULL OR approver <> requester`
- `break_glass_expires_after_activation`: `expires_at IS NULL OR activated_at IS NULL OR expires_at > activated_at`
- `break_glass_evidence_guard` trigger: blocks DELETE and UPDATE of `ticket_ref`, `requester`, `reason`, `requested_scopes`, `created_at`

Migration: `backend/migrations/1810000000000_break-glass-grants.js`

Rollback: `npm run migrate:down` drops the table and guard function cleanly.

---

## API reference

All endpoints require either:
- JWT + admin role (`Authorization: Bearer <token>` where wallet is in `ADMIN_WALLETS`), or
- `x-api-key: <admin:break-glass key>` (see INTERNAL_API_KEY scoped format)

### `POST /api/v1/admin/break-glass`

Request emergency access.

```json
{
  "ticketRef": "INC-1234",
  "reason": "Production database connection pool exhausted; need read access to diagnose query patterns",
  "requestedScopes": ["read:loans", "admin:indexer"],
  "durationSeconds": 3600
}
```

Returns 201 with the new grant in `pending` state.

**Validation failures (400):**
- `ticketRef` missing or empty
- `reason` shorter than 20 characters
- `requestedScopes` empty or contains disallowed scopes
- `durationSeconds` ≤ 0 or exceeds `BREAK_GLASS_MAX_DURATION_HOURS × 3600`

---

### `GET /api/v1/admin/break-glass`

List grants. Supports `?state=`, `?requester=`, `?limit=`, `?cursor=` for filtering and pagination.

---

### `GET /api/v1/admin/break-glass/:id`

Fetch a single grant by ID.

---

### `POST /api/v1/admin/break-glass/:id/approve`

Approve a pending grant. The approver must be a different admin. The `grantedScopes` may be a strict subset of `requestedScopes`.

```json
{ "grantedScopes": ["read:loans"] }
```

Returns 200 with the updated grant in `approved` state.

**Errors:**
- 403 if `approver == requester`
- 409 if grant is not in `pending` state
- 400 if `grantedScopes` contains scopes not in `requestedScopes`

---

### `POST /api/v1/admin/break-glass/:id/deny`

Deny a pending grant. Requires a minimum 10-character `denialReason`.

```json
{ "denialReason": "No active incident matches this ticket reference" }
```

---

### `POST /api/v1/admin/break-glass/:id/activate`

Activate an approved grant. **Only the requester may call this.** The expiry clock starts here.

Returns 200 with the updated grant in `active` state including `expiresAt`.

---

### `POST /api/v1/admin/break-glass/:id/revoke`

Revoke a grant from any non-terminal state. Any admin may revoke. Requires a minimum 10-character `revocationReason`.

```json
{ "revocationReason": "Incident resolved; access no longer required" }
```

---

## Alerting

Every lifecycle transition fires:

1. **Structured log** at `WARN` level with the marker `BREAK_GLASS_ALERT` — always present, picked up by any log-based alerter (CloudWatch, Datadog, etc.)
2. **Webhook POST** to `ADMIN_WEBHOOK_URL` or `BREAK_GLASS_ALERT_WEBHOOK` — Slack/Discord/PagerDuty compatible `{ text, attachments }` payload

The `alert_sent_at` and `alert_channels` columns on the grant row are updated after each alert, allowing monitoring to detect missing alerts (`WHERE alert_sent_at IS NULL AND created_at < NOW() - INTERVAL '5 minutes'`).

**Alert events**: `BREAK_GLASS_REQUESTED`, `BREAK_GLASS_APPROVED`, `BREAK_GLASS_DENIED`, `BREAK_GLASS_ACTIVATED`, `BREAK_GLASS_REVOKED`, `BREAK_GLASS_EXPIRED`

---

## Automatic expiry

The `breakGlassExpirySweep` scheduler runs every `BREAK_GLASS_SWEEP_INTERVAL_MS` milliseconds (default 60 s). It:

1. Atomically `UPDATE break_glass_grants SET state = 'expired', expired_at = NOW() WHERE state = 'active' AND expires_at <= NOW()`
2. For each expired grant: writes `BREAK_GLASS_EXPIRED` to `audit_logs`, fires the alert
3. Records run metrics via `jobMetricsService` (job name: `breakGlassExpirySweep`)

The scheduler uses `setInterval` with `interval.unref()` so it does not keep the process alive. It is started in `src/index.ts` after the HTTP server binds and stopped in the graceful shutdown sequence.

---

## Audit trail

Every lifecycle event writes to `audit_logs`:

| Event | Action string | Target |
|---|---|---|
| Request created | `BREAK_GLASS_REQUESTED` | `BreakGlass:<id>` |
| Approved | `BREAK_GLASS_APPROVED` | `BreakGlass:<id>` |
| Denied | `BREAK_GLASS_DENIED` | `BreakGlass:<id>` |
| Activated | `BREAK_GLASS_ACTIVATED` | `BreakGlass:<id>` |
| Revoked | `BREAK_GLASS_REVOKED` | `BreakGlass:<id>` |
| Auto-expired | `BREAK_GLASS_EXPIRED` | `BreakGlass:<id>` |

The payload field includes `ticketRef`, `grantedScopes`, and contextual detail per event. Audit log entries are written via the existing `audit_logs` table and are never deleted.

The `break_glass_grants` table's immutability trigger ensures the evidence columns (`ticket_ref`, `requester`, `reason`, `requested_scopes`, `created_at`) cannot be altered after creation, providing a tamper-evident record even if the database is accessed directly.

---

## Configuration

| Variable | Default | Description |
|---|---|---|
| `BREAK_GLASS_MAX_DURATION_HOURS` | `4` | Maximum grant duration in hours |
| `BREAK_GLASS_DEFAULT_DURATION_HOURS` | `1` | Default if `durationSeconds` not specified |
| `BREAK_GLASS_SWEEP_INTERVAL_MS` | `60000` | Expiry scheduler interval |
| `BREAK_GLASS_ALERT_WEBHOOK` | — | Dedicated webhook URL (falls back to `ADMIN_WEBHOOK_URL`) |
| `ADMIN_WEBHOOK_URL` | — | Shared webhook for admin alerts |
| `INTERNAL_API_KEY` | — | Comma-separated keys; scope format: `admin:break-glass:<value>` |

---

## Operational runbook

### Requesting break-glass access (operator)

```bash
curl -X POST https://api.remitlend.com/api/v1/admin/break-glass \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "ticketRef": "INC-1234",
    "reason": "Production database connection pool exhausted; need read access to diagnose query patterns",
    "requestedScopes": ["read:loans", "admin:indexer"],
    "durationSeconds": 3600
  }'
```

### Approving (second admin)

```bash
curl -X POST https://api.remitlend.com/api/v1/admin/break-glass/42/approve \
  -H "Authorization: Bearer $OTHER_ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d '{ "grantedScopes": ["read:loans"] }'
```

### Activating and using

```bash
# Activate (starts the expiry clock)
curl -X POST https://api.remitlend.com/api/v1/admin/break-glass/42/activate \
  -H "Authorization: Bearer $ADMIN_JWT"

# Check the expiresAt in the response, then use the granted scopes
# The active grant does NOT automatically extend a JWT token's scopes —
# the calling system must check getActiveGrant() and enforce access accordingly.
```

### Emergency revoke

```bash
curl -X POST https://api.remitlend.com/api/v1/admin/break-glass/42/revoke \
  -H "x-api-key: $BREAK_GLASS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "revocationReason": "Incident resolved; access no longer required" }'
```

### Monitoring query — open grants

```sql
SELECT id, requester, ticket_ref, state, expires_at, granted_scopes, alert_sent_at
FROM break_glass_grants
WHERE state IN ('pending', 'approved', 'active')
ORDER BY created_at DESC;
```

### Monitoring query — missing alerts

```sql
SELECT id, state, created_at
FROM break_glass_grants
WHERE alert_sent_at IS NULL
  AND created_at < NOW() - INTERVAL '5 minutes';
```

---

## Compatibility

- No existing endpoints or schemas are changed. New endpoints and table are additive.
- The new `admin:break-glass` API key scope is added to `ApiKeyScope` in `auth.ts`. Existing keys without this scope cannot access break-glass endpoints.
- `BREAK_GLASS_ALLOWED_SCOPES` is a strict allowlist; it does not include `admin:all`. No grant can produce full-admin access.
- The `break_glass_grants` table's `down()` migration drops the table and guard function cleanly; rollback does not leave orphaned objects.
