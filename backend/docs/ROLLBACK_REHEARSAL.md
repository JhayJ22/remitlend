# Rollout / Rollback Rehearsal

> **Issue #861** — automated rollout and rollback rehearsals for expand-contract migrations, mixed application versions, and worker compatibility.

## Purpose

A schema migration is only safe to merge if its rollback path has been exercised under realistic conditions. This document defines the rehearsal framework that provides that guarantee and blocks release when it is not satisfied.

---

## Supported rehearsal scenarios

| Label | Scenario | What is verified |
|-------|----------|-----------------|
| A | Clean forward rollout | All `up()` functions apply without error; schema invariants hold (tables, columns, indexes, triggers present) |
| B | Full rollback | All `down()` functions apply in reverse order without error; schema returns to empty baseline; re-applying all `up()` reaches a consistent state |
| C | Expand-only mixed-version window | Old writer (uses deprecated column) and new writer (uses new column) operate concurrently; sync trigger keeps both representations consistent; backfill invariant holds (no rows with `read=true AND read_at IS NULL`) |
| D | Expand → contract promotion | Contract migration drops deprecated column; sync trigger and function are removed; existing rows have correct new-column values |
| E | Expand rollback | `down()` on the expand migration removes the new column and its sync artifacts without corrupting data in the original column |
| F | Contract rollback | `down()` on the contract migration restores the deprecated column with values derived from the new column |
| G | Concurrent write idempotency | Concurrent old + new writers produce no duplicate rows and no inconsistent column state; idempotency keys on durable queues are enforced |
| H | Worker compatibility | Queue tables (`soroban_write_queue`), scheduler-state tables (`indexer_scheduler_state`), and dead-letter tables survive rollback without orphaned rows or dangling enum types |
| I | Migration idempotency | Running `up()` twice after a full apply is a no-op; `pgmigrations` row count matches file count |
| J | Contract gate rejection | Contract migration aborts when expand was not applied or when unbackfilled rows exist; writing to a dropped column raises an error rather than silently succeeding |
| K | Access-control | `DATABASE_URL` does not point at a production host; no migration applies an unbounded `UPDATE` to a money (stroop) column without a `WHERE` clause |

---

## Files

| File | Role |
|------|------|
| `backend/src/__tests__/rollbackRehearsal.test.ts` | Jest test suite implementing all scenarios above |
| `backend/src/__tests__/fixtures/rollbackRegistry.json` | Registry of every expand-contract pair that must have rehearsal coverage |
| `scripts/check-rollback-coverage.mjs` | Static gate script: validates registry integrity and verifies every entry has a test file on disk |
| `.github/workflows/reusable-rollback-rehearsal.yml` | Reusable CI workflow: static gate + live Postgres rehearsal job |
| `.github/workflows/ci.yml` → job `rollback-rehearsal` | Calls the reusable workflow; wired into the release pipeline |

---

## Running locally

```bash
# 1. Start a local Postgres instance (if you do not have one running)
docker run -d --name remitlend-rehearsal \
  -e POSTGRES_USER=rehearsal \
  -e POSTGRES_PASSWORD=rehearsal \
  -e POSTGRES_DB=rehearsal \
  -p 5432:5432 postgres:16

# 2. Run the full rehearsal suite
cd backend
DATABASE_URL=postgres://rehearsal:rehearsal@localhost:5432/rehearsal \
  npm run test:rollback

# 3. Run the static coverage gate (no DB required)
cd ..
node scripts/check-rollback-coverage.mjs
```

Each test case creates its own isolated Postgres schema (`rb_<timestamp>_<pid>_<label>`) and drops it on completion. No production data is touched.

---

## Registering a new expand-contract migration pair

Whenever a new expand migration is merged, two things are **required** before the next release:

1. **Add a registry entry** in `backend/src/__tests__/fixtures/rollbackRegistry.json` under `expandContractPairs`:

```json
{
  "id": "my-table-new-column",
  "description": "Replace my_table.old_col with my_table.new_col",
  "expandMigration": "<timestamp>_my-table-expand",
  "contractMigration": "<timestamp>_my-table-contract",
  "expandDir": "migrations",
  "contractDir": "migrations-contract",
  "contractMigrationsTable": "pgmigrations_contract",
  "targetTable": "my_table",
  "oldColumn": "old_col",
  "newColumn": "new_col",
  "rehearsalTest": "src/__tests__/rollbackRehearsal.test.ts",
  "rollbackSupported": true,
  "mixedVersionWindowSupported": true,
  "workerCompatibilityChecked": false,
  "notes": "..."
}
```

2. **Add rehearsal test coverage** in `backend/src/__tests__/rollbackRehearsal.test.ts` (or a sibling file also listed in `rehearsalTest`) covering at minimum scenarios C, D, E, F, and J for the new pair.

The static coverage gate (`scripts/check-rollback-coverage.mjs`) will fail CI immediately if the registry entry exists but the test file does not. The live rehearsal job will fail if the test cases do not pass.

### If rollback is not supported

Set `"rollbackSupported": false` and provide a mandatory `"notes"` field explaining why the migration is irreversible and what the operational recovery path is instead. The gate will still require a test that documents and asserts the irreversibility.

---

## Worker compatibility entries

Workers that read from or write to tables affected by an expand-contract migration must be listed in the `workerCompatibilityMatrix` in the registry. The required fields are `id`, `migration`, `rehearsalTest`, and `rollbackSupported`. Scenario H in the test suite exercises these.

---

## CI integration

The `rollback-rehearsal` job in `ci.yml`:

- Always runs the **static coverage gate** (`coverage-gate` sub-job) on every PR and push to `main`. This exits non-zero if any registry entry is missing a test file.
- Runs the **live rehearsal** (`rehearsal` sub-job) whenever `backend/migrations/**`, `backend/migrations-contract/**`, the registry, or the test file changes, and always on push to `main`.
- Blocks the release when either sub-job fails.

The `deploy-staging.yml` rollback job relies on migrations being forward-compatible (old image can run against new schema). The rehearsal suite enforces this by verifying that the expanded schema is backward-readable by old writers during the mixed-version window (scenario C) before the contract phase is applied.

---

## Constraints and failure behaviour

- **No financial side-effects**: the rehearsal always uses isolated test schemas. The access-control test (scenario K) rejects any `DATABASE_URL` that contains production host indicators (`prod`, `rds.amazonaws.com`, `supabase.co`, `.neon.tech`), unless `ROLLBACK_REHEARSAL_ALLOW_PROD=1` is explicitly set.
- **Partial migration state is a failure**: any rehearsal state not explicitly covered by an up/down pair fails the gate. There is no "partial rollback is acceptable" escape hatch.
- **Stale actions are errors**: after the contract phase drops a column, any write that references the old column must raise a `column not found` error (scenario J). Silent no-ops are considered failures.
- **Idempotency is required**: re-running `migrate up` on a fully-applied schema must be a no-op (scenario I). Migrations that fail on second application are rejected.

---

## Validation evidence

The live rehearsal job uploads its Jest output as a GitHub Actions artifact named `rollback-rehearsal-results` with a 14-day retention window. The job summary table (populated in the CI workflow's `Summary` step) provides a per-scenario status view directly in the Actions UI.

To reproduce locally, run `npm run test:rollback` with a local `DATABASE_URL` as shown above and inspect the Jest output. The `--forceExit` flag passed in CI ensures the process exits cleanly even if a leaked async handle remains after the pool is closed.
