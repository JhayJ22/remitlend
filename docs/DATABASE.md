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
