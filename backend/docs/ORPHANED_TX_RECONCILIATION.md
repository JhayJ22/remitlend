# Orphaned Transaction Reconciliation

> **Issue #858** — Durable reconciliation for orphaned transaction submissions.

## Problem

A transaction submission is *orphaned* when a client or worker submitted a signed transaction to the Soroban RPC and recorded the `tx_hash` in `transaction_submissions`, but never received or persisted a confirmed/failed result. This happens during:

- Network partitions between the backend and the Soroban RPC endpoint
- Worker process crashes immediately after the HTTP call to the RPC
- RPC-side timeouts where the transaction was actually accepted but the response was lost
- Race conditions in distributed deployments (multiple pods)

Without explicit reconciliation, the system faces two risks:

1. **Silent drop** — the transaction is never retried and the user's intent is lost forever.
2. **Double-execution** — the transaction is resubmitted without checking whether the original already landed, triggering duplicate financial operations on-chain.

This feature eliminates both risks by tracking orphaned intents in a durable state machine, distinguishing *not-found* from *delayed finality*, and blocking resubmission until the finality window has elapsed.

---

## State machine

```
transaction_submissions.status NOT IN ('confirmed', 'failed')
AND submitted_at < NOW() - detection_threshold
        │
        ▼ (scheduler detects, inserts into orphaned_tx_reconciliation)
   pending_check
        │
        ▼ (reconciler polls Soroban RPC)
        │
  ┌─────┴──────────────────────┐
  │ found                       │ not found
  │                             │
  ▼                             ▼
  found.status == SUCCESS?    finality window elapsed?
  │ YES        │ NO             │ NO            │ YES
  ▼            ▼                ▼               ▼
confirmed  failed_on_chain  finality_pending  orphaned
                                                │
                                     operator/user calls POST /resubmit
                                                │
                                           resubmitted
  Any state ──────────────────────────────► resolved
                               (operator manual resolution)
```

### Terminal states
`confirmed`, `failed_on_chain`, `resubmitted`, `resolved` — no further scheduler processing.

### Non-terminal states
`pending_check`, `finality_pending` — the scheduler continues polling on each interval tick.

---

## Safety invariants

| Invariant | Enforcement |
|---|---|
| Resubmission only from `orphaned` state | `approveResubmit()` checks state before writing; returns 409 otherwise |
| `finality_pending` blocks resubmission | Distinct 409 error code `TX_RESUBMIT_BLOCKED` with explanation |
| Confirmed and failed transactions cannot be resubmitted | Same 409 guard |
| `newTxHash` must differ from original | Validated in `approveResubmit()` |
| No financial data is mutated | The service only writes to `transaction_submissions.status` and `orphaned_tx_reconciliation`; it never touches loan balances, scores, or remittances |
| Idempotent detection | `ON CONFLICT (submission_id) DO NOTHING` in the INSERT |
| One reconciliation row per submission | `UNIQUE (submission_id)` DB constraint |
| RPC failure does not stall all rows | Each row is processed independently; errors are counted and the loop continues |

---

## Schema changes

### New table: `orphaned_tx_reconciliation`

```sql
id               bigserial PRIMARY KEY
submission_id    integer NOT NULL REFERENCES transaction_submissions ON DELETE RESTRICT UNIQUE
tx_hash          varchar(64) NOT NULL
submitted_by     varchar(56)
transaction_type varchar(20) NOT NULL DEFAULT 'loan'
state            varchar(24) NOT NULL DEFAULT 'pending_check'
                 CHECK (state IN ('pending_check','finality_pending','confirmed',
                                  'failed_on_chain','orphaned','resubmitted','resolved'))
check_attempts   integer NOT NULL DEFAULT 0
last_rpc_check_at timestamptz
confirmed_ledger bigint
rpc_result_xdr   text
rpc_error_detail text
finality_deadline_at timestamptz NOT NULL DEFAULT NOW() + INTERVAL '5 minutes'
resubmit_approved_by varchar(56)
resubmitted_at   timestamptz
resubmit_tx_hash varchar(64)
resolution_note  text
resolved_by      varchar(56)
resolved_at      timestamptz
created_at       timestamptz NOT NULL DEFAULT NOW()
updated_at       timestamptz NOT NULL DEFAULT NOW()
```

### New columns on `transaction_submissions`

| Column | Type | Purpose |
|---|---|---|
| `reconciliation_state` | `varchar(24)` | Denormalized state for fast scans without a join |
| `first_checked_at` | `timestamptz` | When the reconciler first checked this submission |
| `last_checked_at` | `timestamptz` | When the reconciler last checked this submission |

Migration: `backend/migrations/1809000000000_orphaned-tx-reconciliation.js`

Rollback: `npm run migrate:down` removes the new table and drops the three columns.

---

## API reference

### `GET /api/v1/transactions/:txHash/reconciliation`

Returns the reconciliation record for a submitted transaction.

**Auth:** JWT (original submitter) or `admin:reconciliation` API key.

**Response 200:**
```json
{
  "success": true,
  "data": {
    "submission": {
      "id": 42,
      "txHash": "aaa...aaa",
      "status": "orphaned",
      "submittedAt": "2026-11-19T10:00:00Z",
      "transactionType": "loan",
      "reconciliationState": "orphaned"
    },
    "reconciliation": {
      "id": 7,
      "txHash": "aaa...aaa",
      "state": "orphaned",
      "checkAttempts": 4,
      "finalityDeadlineAt": "2026-11-19T10:05:00Z",
      ...
    }
  }
}
```

Returns `reconciliation: null` when the submission exists but has not yet been classified as an orphan candidate.

**Response 404:** Transaction not found.

---

### `POST /api/v1/transactions/:txHash/resubmit`

Approves resubmission of an orphaned transaction. Only permitted when `state = orphaned`.

**Auth:** JWT (original submitter) or `admin:reconciliation` API key.

**Body:**
```json
{ "newTxHash": "bbb...bbb" }
```

**Response 200:** Updated reconciliation record with `state = resubmitted`.

**Response 409:** Resubmission blocked. The response body includes the current state and a human-readable reason:
- `state = finality_pending`: the finality window has not yet elapsed
- `state = confirmed`: the transaction was found on-chain
- `state = failed_on_chain`: the transaction failed on-chain (fix and resubmit as a new intent)
- `state = resubmitted`: already resubmitted (idempotent — returns 200)

---

### `GET /api/v1/admin/transactions/reconciliation`

Lists all reconciliation records. Supports filtering by state and cursor pagination.

**Auth:** `admin:reconciliation` API key.

**Query params:**
- `state` — filter by state (optional)
- `limit` — max 200, default 50
- `cursor` — cursor-based pagination (id of last row from previous page)

---

### `POST /api/v1/admin/transactions/reconciliation/:id/resolve`

Manually resolves a reconciliation record (operator decision). Requires a minimum 10-character resolution note.

**Auth:** `admin:reconciliation` API key.

**Body:**
```json
{
  "resolvedBy": "GADMIN...",
  "resolutionNote": "Confirmed as duplicate submission from a network partition event on 2026-11-19"
}
```

**Response 200:** Resolved reconciliation record.

---

## Configuration

| Environment variable | Default | Description |
|---|---|---|
| `ORPHANED_TX_RECONCILE_INTERVAL_MS` | `60000` | Scheduler interval in ms |
| `ORPHANED_TX_DETECTION_THRESHOLD_MS` | `60000` | Minimum submission age before orphan detection |
| `ORPHANED_TX_FINALITY_WINDOW_MS` | `300000` | Finality window in ms (minimum 30 s) |
| `ORPHANED_TX_BATCH_SIZE` | `50` | Max rows processed per scheduler tick |

---

## Scheduler lifecycle

The reconciler runs as an in-process background scheduler, registered alongside the existing cross-contract reconciler and score reconciliation service.

**Start:** called in `src/index.ts` after the HTTP server binds, via `startOrphanedTxReconciler()`.

**Stop:** called in the graceful shutdown sequence via `stopOrphanedTxReconciler()`. The scheduler uses `interval.unref()` so it does not keep the process alive.

**Concurrency:** an `inFlight` boolean prevents concurrent runs. If a tick is still executing when the next interval fires, the second tick is skipped.

**RPC failure handling:** a failed RPC call for a single row increments `check_attempts` and sets `rpc_error_detail` without changing `state`, then continues to the next row. The row is retried on the next scheduler tick.

---

## Operational runbook

### Identifying orphaned transactions

```sql
SELECT id, tx_hash, submitted_at, state
FROM transaction_submissions
WHERE reconciliation_state = 'orphaned'
ORDER BY submitted_at ASC;
```

Or via API:
```bash
curl -H "x-api-key: $INTERNAL_API_KEY" \
  "https://api.example.com/api/v1/admin/transactions/reconciliation?state=orphaned"
```

### Approving a resubmission

1. The original submitter re-signs the transaction and obtains a new `tx_hash`.
2. Call `POST /api/v1/transactions/:originalTxHash/resubmit` with `{ "newTxHash": "..." }`.
3. The endpoint records `state = resubmitted` and returns the updated record.
4. The submitter then submits the new signed transaction to the Soroban RPC directly.

### Manually resolving a stale record

Use `POST /api/v1/admin/transactions/reconciliation/:id/resolve` with a detailed `resolutionNote` explaining the outcome (e.g. "confirmed via block explorer that tx never landed; original intent cancelled by user").

### Monitoring

The scheduler records run metrics via `jobMetricsService`. The job name is `orphanedTxReconciler`. Metrics are exposed at `GET /metrics` (requires `admin:indexer` key).

Log markers:
- `orphaned_tx_reconciler.tx_orphaned` — WARNING level, emitted when a tx is first classified as orphaned
- `orphaned_tx_reconciler.resubmit_approved` — INFO level
- `orphaned_tx_reconciler.resolved` — INFO level
- `orphaned_tx_reconciler.run.complete` — INFO level, emitted after each scheduler tick

---

## Compatibility

- No existing API responses change. New endpoints are additive.
- `transaction_submissions.status` gains new values: `orphaned`. Existing consumers treating unrecognised statuses as "pending" will continue to work correctly.
- The new columns (`reconciliation_state`, `first_checked_at`, `last_checked_at`) are nullable with no default for pre-existing rows, so old application versions tolerate the new schema without code changes (expand-compatible).
- The `orphaned_tx_reconciliation` table uses `ON DELETE RESTRICT` on the FK to `transaction_submissions` to prevent silent data loss.
