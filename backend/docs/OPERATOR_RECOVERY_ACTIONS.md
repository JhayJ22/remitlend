# Operator Recovery Actions

> Issue #866 — Signed operator actions for financial recovery tooling

## Overview

The operator recovery action system provides a narrow, auditable interface for
performing reconciliation and retry commands. It enforces:

- **Scoped operator identity** — the operator must hold a valid JWT (`admin`
  role) *and* a scoped API key with the `admin:recovery` scope.
- **Reason code** — a bounded enum prevents free-form abuse and allows
  dashboard/alerting filters without parsing prose.
- **Approval reference** — every action must carry an external reference (e.g.
  Jira ticket, incident ID, or a `privileged_action_requests.id`) linking it to
  an out-of-band authorisation.
- **Idempotency key** — the global `Idempotency-Key` header enforcement is
  preserved; the key is also stored in the immutable record so the HTTP request
  and the outcome row are unambiguously correlated.
- **Operator signature** — HMAC-SHA256 keyed with the operator's
  `admin:recovery` API key secret over
  `${operator_id}|${action_type}|${idempotency_key}|${canonical_payload}`.
  The service re-derives and verifies this before any database write.
- **Immutable outcome record** — `operator_recovery_actions` rows are
  append-only: a Postgres trigger blocks DELETE and blocks mutation of identity
  / payload / signature columns. Only the status-machine columns (`status`,
  `outcome_ref`, `outcome_error`, `executed_at`) may change.

Arbitrary balance edits are explicitly prohibited. The `rejectBalanceEdits`
guard is applied by every executor before touching any external system. Any
payload that contains a key matching `balance`, `amount`, `principal`,
`collateral`, `adjust_outstanding`, `set_balance`, or `override_amount` is
rejected with 400 before the action transitions to `executing`.

---

## Supported Action Types

| `action_type` | Description |
|---|---|
| `reconciliation_retry` | Bumps observation metadata on an open reconciliation discrepancy without resolving it. |
| `reconciliation_resolve` | Marks a discrepancy as resolved with a reason and evidence. Wraps `resolveDiscrepancy`. |
| `cross_contract_reconcile` | Marks a half-applied `cross_contract_reconciliation` row as reconciled after operator on-chain verification. |
| `loan_state_replay` | Appends an `OperatorReplayRequested` event to the loan state log to trigger indexer re-processing. |
| `loan_event_retry` | Appends a `LoanEventRetry` event to the loan state log for a specific missed on-chain event. |

---

## Supported Reason Codes

`indexer_lag` · `contract_event_missed` · `db_write_failure` ·
`duplicate_event` · `stale_snapshot` · `manual_reconciliation` ·
`operator_requested`

---

## State Machine

```
pending ──execute()──► executing ──(success)──► completed
                                └──(failure)──► failed
pending ──reject()───► rejected
```

A `completed` or `failed` action cannot be re-executed. A new action with a
fresh idempotency key must be submitted.

---

## API Endpoints

All endpoints require `Authorization: Bearer <jwt>` (admin role) **and**
`X-API-Key: <admin:recovery key secret>`.

| Method | Path | Description |
|---|---|---|
| `GET` | `/admin/recovery-actions/meta` | Enumeration of supported action types and reason codes. |
| `GET` | `/admin/recovery-actions` | List actions (filterable by operator_id, action_type, status, approval_reference; keyset pagination via `cursor`). |
| `POST` | `/admin/recovery-actions` | Submit a new signed recovery action (returns `201`). |
| `GET` | `/admin/recovery-actions/:id` | Fetch a single record. |
| `POST` | `/admin/recovery-actions/:id/execute` | Execute a pending action exactly once. |
| `POST` | `/admin/recovery-actions/:id/reject` | Cancel a pending action. |

### POST /admin/recovery-actions

Required headers:
- `Authorization: Bearer <jwt>`
- `X-API-Key: <admin:recovery key secret>`
- `Idempotency-Key: <client-unique UUID or opaque string>`

Required body:

```json
{
  "action_type": "reconciliation_retry",
  "reason_code": "indexer_lag",
  "approval_reference": "JIRA-1234",
  "operator_signature": "<64-char lowercase hex HMAC-SHA256>",
  "payload": { "discrepancy_id": 42 },
  "reason_note": "Indexer caught up after 5-minute lag; re-checking discrepancy."
}
```

### Computing `operator_signature`

```
message = `${operator_id}|${action_type}|${idempotency_key}|${canonical_payload}`
signature = HMAC-SHA256(message, admin_recovery_key_secret)
```

Where `canonical_payload` is the deterministic JSON representation of the
`payload` object: keys sorted recursively, no extra whitespace.

Example (Node.js):

```ts
import crypto from 'node:crypto';

const canonical = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map(k => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
};

const message = `${operatorId}|${actionType}|${idempotencyKey}|${canonical(payload)}`;
const signature = crypto.createHmac('sha256', recoveryKeySecret).update(message).digest('hex');
```

---

## Configuration

Add an `admin:recovery:<secret>` entry to `INTERNAL_API_KEY`:

```
INTERNAL_API_KEY=admin:reconciliation:<secret1>,admin:recovery:<secret2>
```

Multiple keys are supported (comma-separated). Verification passes when any
configured `admin:recovery:` key validates the HMAC.

---

## Schema

Table: `operator_recovery_actions`

| Column | Type | Notes |
|---|---|---|
| `id` | serial PK | — |
| `operator_id` | varchar(255) | Wallet public key (G…) |
| `action_type` | varchar(64) | Constrained by CHECK |
| `reason_code` | varchar(64) | Constrained by CHECK |
| `approval_reference` | varchar(255) | External reference, min 3 chars |
| `idempotency_key` | varchar(255) UNIQUE | Client-supplied |
| `operator_signature` | varchar(64) | HMAC-SHA256 hex |
| `payload` | jsonb | Schema-validated per action_type |
| `payload_hash` | varchar(64) | SHA-256 of action_type + canonical payload |
| `status` | varchar(16) | `pending/executing/completed/failed/rejected` |
| `outcome_ref` | varchar(255) | Populated on success |
| `outcome_error` | text | Populated on failure (max 500 chars) |
| `executed_at` | timestamp | — |
| `reason_note` | text | Free-text, min 10 chars |
| `created_at` | timestamp | Immutable |

**Postgres trigger** `operator_recovery_actions_guard`:
- Blocks all DELETEs.
- Blocks UPDATE of identity/payload/signature columns.
- Permits UPDATE of `status`, `outcome_ref`, `outcome_error`, `executed_at`.

---

## Audit Trail

Every state transition appends a row to `audit_logs`:

| Action | When |
|---|---|
| `OPERATOR_RECOVERY_CREATED` | On `POST /recovery-actions` |
| `OPERATOR_RECOVERY_EXECUTING` | Immediately before executor runs |
| `OPERATOR_RECOVERY_COMPLETED` | On success |
| `OPERATOR_RECOVERY_FAILED` | On executor error |
| `OPERATOR_RECOVERY_REJECTED` | On `POST /recovery-actions/:id/reject` |

The `auditLog` middleware also records a generic entry for every write to these
endpoints (actor, method+path, sanitized body, IP, HTTP status).

---

## Security Invariants

1. The `operator_signature` is verified before any database write in
   `createRecoveryAction`. A missing or wrong key returns 401.
2. `rejectBalanceEdits` runs inside every executor. A balance-edit payload
   causes the action to transition to `failed` with a clear `outcome_error`.
3. The `strictRateLimiter` (10 req / 45 min per IP) is applied to all write
   endpoints.
4. The idempotency layer caches 2xx/4xx responses for 24 hours. A second
   request with the same `Idempotency-Key` returns the cached response without
   re-executing the action. The `idempotency_key` UNIQUE constraint on the table
   provides a database-level second line of defence.
5. The claim transition (`pending → executing`) is a single conditional UPDATE.
   Concurrent or replayed executions cannot both proceed.

---

## Migration

`backend/migrations/1809000000000_operator-recovery-actions.js`

Run with the standard migration command:

```bash
npm run db:migrate
```

The migration creates `operator_recovery_actions` and the immutability trigger.
It is fully reversible via `down`.
