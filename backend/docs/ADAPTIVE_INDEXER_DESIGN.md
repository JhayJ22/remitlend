# Adaptive Catch-Up Scheduling Design

**Status**: Design Phase  
**Version**: 1.0  
**Date**: 2026-10-16

## Executive Summary

Replace the fixed 30-second poll interval in EventIndexer with an adaptive scheduling system that detects when the indexer falls behind the chain tip and automatically accelerates catch-up. The system maintains backward compatibility while improving responsiveness during peak event periods and RPC degradation.

## Objectives

1. **Reduce catch-up latency** when the indexer falls behind by 100+ ledgers
2. **Gracefully degrade** when RPC is slow or unstable
3. **Maintain backward compatibility** with all existing API consumers and deployed contracts
4. **Add observability** for indexer scheduling decisions and health
5. **Enable operators** to tune behavior via environment variables

## Algorithm Overview

### Catch-Up Modes

The scheduler operates in three modes:

#### 1. **Caught-Up Mode** (lag ≤ CAUGHT_UP_THRESHOLD)
- Poll interval: 30 seconds (normal)
- Batch size: 100 (normal)
- Rationale: Chain is current; periodic polling is sufficient

#### 2. **Behind Mode** (CAUGHT_UP_THRESHOLD < lag ≤ AGGRESSIVE_THRESHOLD)
- Poll interval: 10 seconds (aggressive)
- Batch size: 200 (increased)
- Rationale: Fell behind but not severely; moderate acceleration

#### 3. **Catch-Up Mode** (lag > AGGRESSIVE_THRESHOLD)
- Poll interval: 3 seconds (very aggressive)
- Batch size: 500 (max)
- Rationale: Significantly behind; maximum acceleration until caught up

### Transition Rules

1. **Caught-Up → Behind**: When `lag > CAUGHT_UP_THRESHOLD`
2. **Behind → Catch-Up**: When `lag > AGGRESSIVE_THRESHOLD`
3. **Catch-Up → Behind**: When `lag ≤ AGGRESSIVE_THRESHOLD && lag > CAUGHT_UP_THRESHOLD`
4. **Behind/Catch-Up → Caught-Up**: When `lag ≤ CAUGHT_UP_THRESHOLD`

### Backoff Strategy

When RPC fails or returns 0 ledger:

1. **First failure**: Log warning, keep current mode
2. **Consecutive failures**: Apply exponential backoff
   - Failure 1: wait 5 seconds extra
   - Failure 2: wait 15 seconds extra (3x)
   - Failure 3: wait 45 seconds extra (3x)
   - Failure 4+: wait 135 seconds extra (capped)
3. **Recovery**: After 1 successful poll, reset failure counter

**Backoff Formula**:
```
delay_ms = base_interval + (backoff_base_ms * (3 ^ consecutive_failures))
capped at: base_interval + backoff_max_ms
```

### State Machine

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  ┌──────────────┐         ┌──────────────┐               │
│  │  Caught-Up   │<───────>│   Behind     │                │
│  │(30s, 100)    │         │ (10s, 200)   │                │
│  └──────────────┘         └──────────────┘                │
│        ^                         │                         │
│        │ lag ≤ threshold         │ lag > aggressive       │
│        │                         ▼                         │
│        │                   ┌──────────────┐               │
│        └──────────────────│  Catch-Up    │               │
│                           │ (3s, 500)    │               │
│                           └──────────────┘               │
│                                                             │
└─────────────────────────────────────────────────────────────┘

Backoff applied to all modes on RPC failures
```

## State Persistence

### New Table: `indexer_scheduler_state`

```sql
CREATE TABLE indexer_scheduler_state (
  id SERIAL PRIMARY KEY,
  contract VARCHAR(56) NOT NULL UNIQUE,
  
  -- Current mode: 'caught_up', 'behind', or 'catch_up'
  mode VARCHAR(20) NOT NULL DEFAULT 'caught_up',
  
  -- Backoff tracking
  consecutive_failures INT NOT NULL DEFAULT 0,
  last_poll_time TIMESTAMP,
  last_successful_poll_time TIMESTAMP,
  
  -- Diagnostic metadata
  last_lag_ledgers INT,
  last_error_message TEXT,
  
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

**Why**: Survive restarts without losing catch-up context. Allows operational diagnostics.

## Configuration

### Environment Variables

```env
# Adaptive scheduler thresholds (ledgers)
INDEXER_CAUGHT_UP_THRESHOLD=50        # Switch from catch-up to behind
INDEXER_AGGRESSIVE_THRESHOLD=100      # Switch from behind to catch-up

# Mode-specific intervals (milliseconds)
INDEXER_INTERVAL_CAUGHT_UP_MS=30000   # Normal polling
INDEXER_INTERVAL_BEHIND_MS=10000      # Moderate acceleration
INDEXER_INTERVAL_CATCH_UP_MS=3000     # Aggressive catch-up

# Mode-specific batch sizes (ledgers)
INDEXER_BATCH_SIZE_CAUGHT_UP=100      # Normal batch
INDEXER_BATCH_SIZE_BEHIND=200         # Increased during behind
INDEXER_BATCH_SIZE_CATCH_UP=500       # Max batch during catch-up

# Backoff configuration
INDEXER_BACKOFF_BASE_MS=5000          # Initial backoff
INDEXER_BACKOFF_MAX_MS=135000         # Max total backoff
INDEXER_BACKOFF_MULTIPLIER=3          # Exponential multiplier

# Feature flag for adaptive mode (safe to disable for rollback)
INDEXER_ADAPTIVE_SCHEDULING=true
```

**Backward Compatibility**: If `INDEXER_ADAPTIVE_SCHEDULING=false`, fall back to fixed interval/batch (current behavior).

## Metrics

### New Gauges

- `indexer_scheduler_mode` (gauge) - Current mode: 0=caught_up, 1=behind, 2=catch_up
- `indexer_backoff_level` (gauge) - Current backoff multiplier (0-N)
- `indexer_consecutive_failures` (counter) - Consecutive RPC failures since last success

### New Counters

- `indexer_mode_transitions` (counter) - Transitions between modes (label: from→to)
- `indexer_backoff_triggered` (counter) - Times backoff was activated

### Existing Metrics (Enhanced)

- `indexer_lag_ledgers` (gauge) - Already tracked; will drive mode transitions
- `indexer_poll_duration_ms` (histogram) - Already tracked; used to tune intervals

## Logging

### Structured Log Events

1. **Mode Transition**
   ```json
   {
     "event": "indexer_mode_transition",
     "from": "caught_up",
     "to": "behind",
     "lag": 120,
     "threshold": 100,
     "interval_ms": 10000,
     "batch_size": 200
   }
   ```

2. **Backoff Triggered**
   ```json
   {
     "event": "indexer_backoff_triggered",
     "consecutive_failures": 2,
     "backoff_ms": 45000,
     "total_wait": 55000,
     "reason": "RPC getLatestLedger failed"
   }
   ```

3. **Catch-Up Completed**
   ```json
   {
     "event": "indexer_catch_up_complete",
     "lag_before": 500,
     "lag_after": 0,
     "duration_ms": 15000,
     "events_processed": 1250
   }
   ```

## Authorization & Security

### API Access

- `/indexer/status` returns `scheduler_mode` and `backoff_level` in response (no auth change)
- `/admin/indexer/reset-backoff` to reset consecutive_failures (admin:indexer scope, new)
- No sensitive data exposed in metrics or logs

### Threat Model

| Threat | Mitigation |
|--------|-----------|
| DoS by rapid config changes | Environment variables only; no runtime API |
| Unbounded memory in failure tracking | Consecutive_failures capped; backoff capped |
| Information disclosure | All metrics are operational health; no PII/secrets |
| Unintended catch-up spam | Thresholds tuned conservatively; metrics monitored |

## Failure Scenarios

### Scenario 1: RPC Becomes Slow
- **Initial**: Caught-Up mode, 30s interval
- **Minute 1**: RPC latency 5s → poll takes 8s, still 30s interval (lag grows)
- **Minute 2**: Lag > 50 → Enter Behind mode, 10s interval
- **Minute 3**: Lag > 100 → Enter Catch-Up mode, 3s interval (plus backoff)
- **Minute 5**: RPC recovers → Lag shrinks, exit Catch-Up, shrink batch, restore 30s

### Scenario 2: RPC Outage During Restart
- **Restart**: `indexer_scheduler_state` loaded from DB
- **State**: Previous mode (e.g., "catch_up") restored
- **Backoff**: consecutive_failures = 0, backoff_level reset
- **Polling**: Resumes with adaptive intervals despite RPC down
- **Recovery**: After RPC recovers, scheduler adjusts based on lag

### Scenario 3: Ledger Gap + Slow Recovery
- **Gap detected**: 200-ledger gap
- **Catch-Up mode**: 3s interval, 500 batch
- **RPC slow**: Backoff kicks in (5s → 15s → 45s)
- **Recovery**: RPC recovers, backoff resets, catch-up continues
- **Caught up**: Lag ≤ 50, return to Caught-Up mode

## Governed Data-Access Request Workflow for Analysts

Sensitive analytical datasets (e.g., per-account loan history, indexed event streams) require a governed, auditable access workflow. This section defines the contract for that workflow so that grants are purpose-bound, minimal, time-limited, and attributable.

### Supported States

An access request moves through the following states:

| State | Meaning |
|-------|---------|
| `requested` | Analyst submitted a request; awaiting approver decision |
| `approved` | Approver accepted the request; grant not yet issued |
| `granted` | Access is active until `expires_at` |
| `denied` | Approver rejected the request (terminal) |
| `revoked` | An active grant was withdrawn before expiry (terminal) |
| `expired` | Grant lapsed past `expires_at` (terminal, set by the sweeper) |

### Transition Rules

Valid transitions (all others are rejected with `409 Conflict` and no side effects):

- `requested → approved` (by designated approver)
- `requested → denied` (by designated approver)
- `approved → granted` (by grantor/system)
- `granted → revoked` (by approver or grantor)
- `granted → expired` (by system sweeper only)

Stale actions (e.g., approving an already-`granted` request, revoking an `expired` grant) are rejected atomically; the request row is not mutated and no audit record is written for the rejected attempt beyond a `rejected_transition` log line.

### Input Constraints

A request is rejected at creation (`422 Unprocessable Entity`) unless all of the following hold:

- **Stated purpose**: `purpose` is a non-empty string (≤ 500 chars) describing the analytical question.
- **Minimal dataset**: `dataset_scope` is a non-empty allow-listed set of dataset identifiers; wildcard/`*` scopes are rejected.
- **Bounded expiry**: `expires_at` is in the future and no more than `MAX_ACCESS_TTL` (default 30 days) from `requested_at`.
- **Designated approver**: `approver_id` is present and **must differ from** `requester_id` (no self-approval).

### Authorization & Consent

- Only the designated `approver_id` may transition `requested → approved|denied`.
- Only a grantor (role `data:grant`) or the system may transition `approved → granted`.
- The requester can never approve or grant their own request, even if they hold the approver role.
- Revocation requires the approver, the grantor, or an admin with `data:revoke` scope.

### Audit Log

Every `granted`, `revoked`, and `expired` transition writes an immutable audit record:

```json
{
  "event": "data_access_granted",
  "request_id": "dar_01H...",
  "actor_id": "user_123",
  "actor_role": "data:grant",
  "requester_id": "user_456",
  "dataset_scope": ["loan_history", "indexed_events"],
  "purpose": "Q4 delinquency cohort analysis",
  "expires_at": "2026-11-15T00:00:00Z",
  "timestamp": "2026-10-16T12:00:00Z",
  "reason": null
}
```

Revocations and expirations include a `reason` (`manual_revoke` or `ttl_expired`). Audit records are append-only and never updated or deleted.

### Automatic Expiry

A scheduled sweeper transitions `granted` requests whose `expires_at` has passed to `expired`, writes the corresponding audit record, and removes the effective permission. The sweeper is idempotent: re-running it on an already-`expired` request is a no-op.

### Persistence & Compatibility

- New table `data_access_requests` (id, requester_id, approver_id, purpose, dataset_scope JSONB, state, requested_at, expires_at, decided_at, revoked_at, reason).
- New append-only table `data_access_audit_log`.
- These are additive; no existing indexer tables or API responses change shape. Existing `/indexer/status` consumers are unaffected.

### Failure Behavior

- Invalid transitions and constraint violations return `4xx` with a machine-readable `code` and leave persisted state unchanged (no partial grants).
- Grant issuance and audit write occur in a single transaction; if the audit write fails, the grant is rolled back.
- Dependency failures (DB unavailable) surface as `503` and are safe to retry; the sweeper retries on the next tick.
