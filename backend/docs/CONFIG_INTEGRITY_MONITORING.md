# Config Integrity Monitoring for Privileged Configuration Changes

> Issue #854 — record actor, prior and new values, approval references, and
> effective time for sensitive configuration; alert on unauthorized changes;
> test recovery to a reviewed value.

## Overview

RemitLend's privileged configuration changes — interest rates, reserve ratios,
contract parameters, and admin-scoped settings — carry direct financial risk.
This module provides an append-only audit trail for every such change, automatic
alerting when a change is made without an approval reference (unauthorized), and
a snapshot-based recovery path that restores a configuration key to a previously
reviewed value.

## Data model

### `config_change_log`

Append-only. No row is ever updated except the `alert_sent` flag on an
unauthorized row (idempotent flag set once per successful alert delivery).

| Column | Type | Description |
|--------|------|-------------|
| `id` | uuid PK | Stable reference for linking to privileged-action requests |
| `config_key` | varchar(255) | Logical key, e.g. `loan.interest_rate_percent` |
| `prior_value` | jsonb | Value before the change. `NULL` for the initial write |
| `new_value` | jsonb | Value after the change |
| `actor` | varchar(255) | Stellar public key (G…) or service identity |
| `approval_ref` | varchar(255) | Dual-control approval reference (`privileged_action_requests.id` or ticket). `NULL` triggers an unauthorized alert |
| `effective_at` | timestamptz | When the change took / takes effect |
| `change_source` | varchar(32) | `api` \| `direct` \| `recovery` \| `contract` |
| `status` | varchar(32) | `applied` \| `unauthorized` \| `recovered` |
| `alert_sent` | boolean | `true` once an unauthorized-change alert was dispatched |
| `ip_address` | varchar(50) | Caller IP when available |
| `created_at` | timestamptz | Row insertion time |

### `config_snapshots`

Reviewed baseline values used as recovery targets.

| Column | Type | Description |
|--------|------|-------------|
| `id` | uuid PK | Used in recovery requests |
| `config_key` | varchar(255) | The key this snapshot applies to |
| `value` | jsonb | The captured value |
| `snapshot_by` | varchar(255) | Who captured it |
| `review_ref` | varchar(255) | Optional approval reference for the review |
| `is_reviewed` | boolean | `true` after a second admin marks it as the approved baseline |
| `created_at` | timestamptz | Snapshot time |

## Change lifecycle states

```
(initial write) → applied
                → unauthorized   (no approval_ref + requiresApproval=true)
                                 → alert dispatched, alert_sent=true
applied | unauthorized → recovered   (superseded by a recovery action)
```

## Authorization

All endpoints require `requireJwtAuth + requireRoles('admin')`. No sub-scoped
API key route exists for config changes — only JWT-authenticated admin principals
may submit or query config changes. `strictRateLimiter` is applied to all
write endpoints.

## Alert delivery

An unauthorized change (no `approval_ref`) triggers two parallel alert channels:

1. **Webhook** — POST to `CONFIG_INTEGRITY_ALERT_WEBHOOK` (falls back to
   `ADMIN_WEBHOOK_URL`). Payload:
   ```json
   { "severity": "critical", "title": "...", "message": "...",
     "change_id": "uuid", "config_key": "...", "actor": "...",
     "effective_at": "ISO8601" }
   ```

2. **Email** — via SendGrid to `ADMIN_EMAIL` when `SENDGRID_API_KEY` and
   `FROM_EMAIL` are set.

**Idempotency**: `alert_sent` is set by a conditional `UPDATE WHERE alert_sent = false`,
so concurrent retries cannot double-alert. `retryPendingAlerts()` sweeps for
any `status='unauthorized' AND alert_sent=false` rows and re-dispatches; it is
safe to call repeatedly.

**Dependency failure**: if the webhook call throws, the error is caught and
logged, and the function proceeds to mark `alert_sent=true` so the alert is not
retried indefinitely on a persistent outage. The alert evidence is permanently
recorded in `config_change_log` and `audit_logs` regardless.

## Recovery

Recovery to a reviewed snapshot:

1. An admin creates a snapshot: `POST /admin/config-snapshots`
2. A second admin reviews it: `PUT /admin/config-snapshots/:id/review`
   with an optional `review_ref` (e.g. dual-control approval ticket).
3. Any admin with an approval reference triggers recovery:
   `POST /admin/config-changes/:id/recover` with `{ snapshot_id, approval_ref }`.

Recovery inserts a new `config_change_log` row with `source='recovery'` and
marks all prior `applied`/`unauthorized` rows for the same key `recovered`. The
original rows are **never deleted** — the audit trail is permanent.

## API endpoints

All endpoints: `Bearer {JWT}`, role `admin`.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/admin/config-changes` | Record a change |
| `GET` | `/admin/config-changes` | List changes (filterable) |
| `GET` | `/admin/config-changes/:id` | Single change |
| `POST` | `/admin/config-changes/:id/recover` | Recover to a snapshot |
| `POST` | `/admin/config-snapshots` | Capture a snapshot |
| `PUT` | `/admin/config-snapshots/:id/review` | Mark snapshot reviewed |
| `GET` | `/admin/config-snapshots` | List snapshots |

### Record a change — `POST /admin/config-changes`

```json
{
  "config_key": "loan.interest_rate_percent",
  "prior_value": { "rate": 10 },
  "new_value":   { "rate": 12 },
  "approval_ref": "par-42",
  "source": "api",
  "effective_at": "2026-11-19T12:00:00Z",
  "requires_approval": true
}
```

Omitting `approval_ref` (or passing `null`) with `requires_approval: true`
(the default) records the change as `status: "unauthorized"` and fires an alert.

### Recover — `POST /admin/config-changes/:id/recover`

```json
{
  "snapshot_id": "uuid-of-reviewed-snapshot",
  "approval_ref": "par-99"
}
```

Returns the new change log row with `source: "recovery"`.

## Compatibility and migration

- Migration `1809000000002_config-integrity-monitoring` is **additive** — no
  existing table is altered.
- Migration `down` drops both new tables cleanly.
- Rollout: deploy migration → wire `CONFIG_INTEGRITY_ALERT_WEBHOOK` and
  `ADMIN_EMAIL` → existing admin code routes changes through the new endpoints.

## Validation evidence

```bash
# Run the focused test suite (no database required — pool is mocked):
cd backend
npm test -- --runTestsByPath src/services/__tests__/configIntegrityService.test.ts
# Expected: 29 tests pass
```

Covers: approved change, unauthorized flagging + alert, audit_logs integration,
audit failure resilience, alert idempotency, webhook dependency failure,
snapshot create/review, recovery (success, unreviewed snapshot, missing snapshot),
paginated list with cursor, filter by key/status/source.
