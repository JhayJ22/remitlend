# Database

## Indexes

Indexes are defined in `backend/migrations/1802000000000_optimize-database-indexes.js`.
As data grows and queries change, indexes can become obsolete and new
full-table-scan queries can be introduced without detection.

## Query plan check

The script `scripts/check-query-plans.mjs` runs `EXPLAIN (ANALYZE, FORMAT JSON)`
against a representative set of critical queries:

- loan list (by borrower, by status, by contract)
- score lookup (by borrower, by id)
- notification filter (by user + read, by type)
- event indexer checkpoint (latest, by contract)

If any query plan contains a `Seq Scan` on a table with more than 1,000
estimated rows, the script fails and prints the query and the plan output.

### Running locally

```bash
DATABASE_URL=postgres://user:pass@localhost:5432/db \
  node scripts/check-query-plans.mjs
```

Set `SEQ_SCAN_ROW_THRESHOLD` to override the default 1,000-row threshold.
If `DATABASE_URL` is not set the script exits successfully with a notice.

### CI

The check runs in `.github/workflows/reusable-migration-check.yml` on PRs that
touch `backend/src/services/` or `backend/migrations/`.

### Verifying the check catches missing indexes

To confirm the check detects a missing index, temporarily drop an index in a
test database, run the script, and confirm it reports the `Seq Scan`:

```sql
DROP INDEX IF EXISTS idx_loans_borrower_id;
```

Re-run the script; it should fail with the offending query and plan. Restore
the index afterwards.
### Historical Renames

| Old Name | Current Name | Migration |
|---|---|---|
| `loan_events` (table) | `contract_events` | 1788000000018 |
| `loan_events` (backward-compat view) | `loan_events` (view) | 1788000000018 |
| `borrower` column | `address` | 1788000000018 |
| `user_id` column (scores) | `borrower` | 1789000000000 |
| `current_score` column (scores) | `score` | 1789000000000 |
| `last_indexed_ledger` (indexer_state) | `last_ledger` | 1789000000000 |

---

## Failover Architecture (primary / read-replica)

Implemented in `backend/src/db/failoverConnection.ts` (`FailoverPool`) with alerting via
`backend/src/services/failoverAlertService.ts`.

```
               ┌──────────────── FailoverPool ────────────────┐
  query() ───► │ isReadQuery? ──yes──► replica (if enabled /  │
               │      │                 primary down)         │
               │      no                                      │
               │      ▼                                       │
               │ primary up? ──yes──► primary                 │
               │      │ no                                    │
               │      ▼                                       │
               │ write queue (FIFO, DB_FAILOVER_TIMEOUT_MS)   │
               │      │ primary recovers (health check)       │
               │      └──────► drain to primary               │
               └──────────────────────────────────────────────┘
```

### Pools
- **Primary** (`DATABASE_URL`): all writes, locking reads (`SELECT … FOR UPDATE/SHARE`),
  data-modifying CTEs, and `connect()` clients for transactions.
- **Replica** (`DATABASE_REPLICA_URL`, optional): read-only queries.

### Routing rules
| Condition | Reads (`SELECT`/`WITH`/`SHOW`) | Writes |
|---|---|---|
| Primary healthy, `DB_READ_FROM_REPLICA=false` (default) | primary | primary |
| Primary healthy, `DB_READ_FROM_REPLICA=true` | replica (falls back to primary on replica connection error) | primary |
| Primary down, replica configured | replica | queued |
| Primary down, no replica | error | queued |

### Failover lifecycle
1. **Detection** — a connection-class error (`ECONNREFUSED`, `57P0x`, `08xxx`, pool
   connect timeout) on the primary, or a failed periodic `SELECT 1` health check
   (`DB_HEALTH_CHECK_INTERVAL_MS`, default 10 000 ms), activates failover.
2. **Alert** — `recordFailoverEvent({ type: 'failover_activated' })` logs at error
   level and POSTs a critical alert to `FAILOVER_ALERT_WEBHOOK` when set.
3. **Write queue** — writes wait in a FIFO queue for up to `DB_FAILOVER_TIMEOUT_MS`
   (default 30 000 ms). On timeout the caller receives `FailoverWriteTimeoutError`
   (`code: DB_FAILOVER_TIMEOUT`) and a `write_queue_timeout` event is recorded.
4. **Recovery / re-election** — when the health check succeeds again, a
   `failover_deactivated` event is emitted, the queue drains to the primary in order,
   and normal routing resumes. If the primary drops again mid-drain, remaining items
   stay queued under their original deadlines.

Health status is exposed through `healthController` (`failoverActive`, `recentEvents`).

### Configuration
| Variable | Default | Purpose |
|---|---|---|
| `DB_READ_FROM_REPLICA` | `false` | Route reads to the replica during normal operation |
| `DB_FAILOVER_TIMEOUT_MS` | `30000` | Max time a write waits in the failover queue |
| `DB_HEALTH_CHECK_INTERVAL_MS` | `10000` | Primary health probe interval (`0` disables) |
| `FAILOVER_ALERT_WEBHOOK` | — | Destination for failover alerts |

Covered by `backend/src/__tests__/faultInjection.postgres.test.ts` (replica routing,
primary outage + replica fallback, write-queue timeout, alert emission, recovery drain).
