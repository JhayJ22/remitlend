# Database Restore Rehearsal

> **Issue #859** — Automated rehearsal of database restore with application-level consistency checks.

## Purpose

A backup is only useful if it can be restored correctly. This feature automates the restore rehearsal so every push to `main` verifies that:

1. The most recent logical backup can be restored into an isolated environment.
2. All database migrations are present and applied.
3. All required tables exist and financial data satisfies integrity invariants.
4. The ledger checkpoint gap is within the RPO target.
5. The total restore + check time is within the RTO target.

The release pipeline fails when any critical consistency check fails or either target is breached.

---

## What is checked

### 1. Migration state

| Check | Failure mode | Severity |
|---|---|---|
| `pgmigrations` table exists | Missing — migrations never ran | critical |
| All `.js` files in `backend/migrations/` are recorded in `pgmigrations` | Unapplied migrations remain | critical |
| Applied migration count reported | Informational | info |

### 2. Required table presence

All 36+ tables created by the migration set must exist. Any missing table is a critical failure.

### 3. Row counts

| Table | Requirement |
|---|---|
| `pause_state` | At least one row (populated on first startup) |
| `contract_events`, `transaction_submissions`, `remittances`, `loan_history`, `ledger_checkpoints`, `audit_logs` | Count recorded (informational) |

### 4. Ledger checkpoints

| Check | Failure mode | Severity |
|---|---|---|
| At least one `verified` checkpoint exists | No checkpoints — indexer never ran | critical |
| No `suspect` gaps | Gaps present — some ledger ranges not scanned | warning |
| Latest checkpoint age ≤ RPO target | Checkpoint older than target | warning |

The RPO (data-loss window) is the difference between the timestamp of the latest verified checkpoint and the time the check runs. This directly measures how much ledger history could be lost if the restored database were promoted immediately.

### 5. Financial invariants

| Check | Table | What it verifies | Severity |
|---|---|---|---|
| Stroop integrity | `contract_events.amount` | `amount = trunc(amount)` — no fractional stroops | critical |
| Stroop integrity | `loan_history` (4 columns) | Same check per column | critical |
| Immutability trigger | `reconciliation_discrepancies` | `reconciliation_discrepancies_guard` trigger is live | critical |
| Intent-key uniqueness | `cross_contract_reconciliation` | No duplicate `intent_key` values | critical |
| FK integrity | `orphaned_tx_reconciliation` | All `submission_id` values resolve in `transaction_submissions` | critical |
| Dual-control constraint | `privileged_action_requests` | No row where `approver = initiator` | critical |
| Rule version tracking | `reconciliation_discrepancies` | Stored `rule_version` values match service expectations | warning |

---

## RTO and RPO targets

| Metric | Default target | Override variable |
|---|---|---|
| RTO (restore + check time) | 30 minutes | `RESTORE_RTO_TARGET_MINUTES` |
| RPO (ledger data-loss window) | 5 minutes | `RESTORE_RPO_TARGET_MINUTES` / `RESTORE_RPO_TARGET_MS` |

Both targets align with the values documented in `docs/runbooks/DATABASE_BACKUP_RECOVERY.md` (RPO = 5 min, RTO = 15–30 min).

---

## Files

| File | Role |
|---|---|
| `backend/src/services/restoreConsistencyChecker.ts` | TypeScript library implementing all consistency checks; injectable pg client for testability |
| `scripts/restore-rehearsal.mjs` | Orchestration script: provision DB → download/restore → migrate → check → measure → report |
| `deploy/dr/restore-standby.sh` | Shell entry point called by the CI `dr-drill` job |
| `deploy/dr/start-standby.sh` | Verifies the standby write gate before starting services |
| `deploy/dr/recover-indexer.sh` | Queries the last verified ledger checkpoint in the restored DB |
| `deploy/dr/rpc-failover.sh` | Records the standby Soroban RPC endpoint |
| `deploy/dr/dns-failover.sh` | Records DNS/routing change to standby |
| `deploy/dr/verify-fenced.sh` | Enforces write-fencing before signer/network controls are verified |
| `deploy/dr/reconcile.sh` | Reads the rehearsal report, records RTO/RPO in GITHUB_STEP_SUMMARY, fails if targets breached |
| `deploy/dr/failback.sh` | Verifies rehearsal passed before recording failback |
| `.github/workflows/reusable-restore-rehearsal.yml` | Reusable CI workflow: static analysis + live rehearsal |
| `.github/workflows/ci.yml` → job `restore-rehearsal` | Calls the reusable workflow; gates the release |
| `backend/src/__tests__/restoreConsistencyChecker.test.ts` | Unit tests for the consistency checker and report builder (25+ cases) |
| `backend/docs/RESTORE_REHEARSAL.md` | This document |

---

## Running locally

```bash
# 1. Start a local Postgres instance
docker run -d --name remitlend-rehearsal \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
  -p 5432:5432 postgres:16

# 2. Create and populate a source database
DATABASE_URL=postgres://postgres:postgres@localhost:5432/remitlend_seed \
  npm run migrate:up --prefix backend

# 3. Take a local dump
PGPASSWORD=postgres pg_dump \
  -h localhost -U postgres -d remitlend_seed \
  --no-owner --no-privileges \
  -f /tmp/rehearsal-seed.sql

# 4. Run the restore rehearsal
REHEARSAL_DB_URL=postgres://postgres:postgres@localhost:5432/restore_rehearsal \
  RESTORE_DUMP_FILE=/tmp/rehearsal-seed.sql \
  node scripts/restore-rehearsal.mjs

# 5. Only run consistency checks against an already-restored DB
SKIP_RESTORE=1 \
  REHEARSAL_DB_URL=postgres://postgres:postgres@localhost:5432/restore_rehearsal \
  node scripts/restore-rehearsal.mjs
```

---

## CI integration

### `ci.yml` — job `restore-rehearsal` (job #14)

- **Static checks** (`consistency-checks-static` sub-job): typecheck, deploy/dr script presence, unit tests. Runs on every PR. No database required.
- **Live rehearsal** (`restore-rehearsal` sub-job): full restore cycle against a Postgres service container. Path-filtered; always runs on push to `main`.

Both sub-jobs must pass to unblock the release.

### `deploy-staging.yml` — `dr-drill` job

The `dr-drill` job (triggered manually with `inputs.drill=true`) now calls the real `deploy/dr/*.sh` scripts instead of the previous no-op stubs. The rehearsal report is uploaded as a 30-day artifact.

---

## Report format

The JSON report at `RESTORE_REHEARSAL_REPORT` contains:

```json
{
  "rehearsalId": "restore-rehearsal-1732003200000",
  "generatedAt": "2026-11-19T12:00:00.000Z",
  "rehearsalStartedAt": "...",
  "rehearsalCompletedAt": "...",
  "dumpFile": "/tmp/rehearsal-seed.sql",
  "targetDatabase": "postgres://***@localhost/restore_rehearsal",
  "rto": {
    "observedMs": 480000,
    "observedMinutes": 8,
    "targetMs": 1800000,
    "targetMinutes": 30,
    "breached": false
  },
  "rpo": {
    "observedMs": 180000,
    "observedMinutes": 3,
    "targetMs": 300000,
    "targetMinutes": 5,
    "breached": false
  },
  "consistency": {
    "passed": true,
    "criticalFailures": 0,
    "warnings": 0,
    "migrationCount": 56,
    "tableCount": 36,
    "checks": [...]
  },
  "passed": true,
  "failures": []
}
```

---

## Adding new invariant checks

1. Add a method to `RestoreConsistencyChecker` in `backend/src/services/restoreConsistencyChecker.ts`.
2. Call it from `run()`.
3. Add test cases in `backend/src/__tests__/restoreConsistencyChecker.test.ts`.
4. Update this document with the new check.

For new financial tables: add the table to `REQUIRED_TABLES` and add a targeted SQL query verifying its integrity invariant (stroop scale, FK, constraint, trigger).

---

## Failure response

When the rehearsal fails:

1. Download the `restore-rehearsal-report` artifact from the failing CI run.
2. Find the failing `checks[]` entries (`passed: false`, `severity: "critical"`).
3. The `detail` field explains what was found and which table/column is affected.
4. For RTO breaches: investigate whether the backup size has grown beyond the restore capacity. Consider reducing `ORPHANED_TX_BATCH_SIZE` or splitting large tables into partitions.
5. For RPO breaches: check that the WAL archive timeout is configured correctly (`archive_timeout = 300` in `postgresql.conf`). A breach means the indexer has not committed a verified checkpoint recently enough.

No financial data is ever written or corrected by the rehearsal; all checks are read-only.
