#!/usr/bin/env bash
# deploy/dr/recover-indexer.sh
# Verifies the indexer can resume from the last verified ledger checkpoint
# in the restored database.

set -euo pipefail

echo "::group::Recover indexer checkpoint"

DB_URL="${REHEARSAL_DB_URL:-${DATABASE_URL}}"

if [ -z "${DB_URL}" ]; then
  echo "::error::REHEARSAL_DB_URL or DATABASE_URL is required"
  exit 1
fi

# Query the last verified checkpoint from the restored DB.
LATEST=$(psql "${DB_URL}" -t -c \
  "SELECT COALESCE(MAX(range_end)::text, 'none') FROM ledger_checkpoints WHERE status='verified'" \
  2>/dev/null | tr -d '[:space:]')

if [ "${LATEST}" = "none" ] || [ -z "${LATEST}" ]; then
  echo "::warning::No verified ledger checkpoints found in restored DB; indexer will cold-start from ledger 0"
else
  echo "Last verified ledger checkpoint: ${LATEST}"
  echo "Indexer will resume from ledger ${LATEST} after failover."
fi

# Check for suspect gaps
SUSPECT=$(psql "${DB_URL}" -t -c \
  "SELECT COUNT(*) FROM ledger_checkpoints WHERE status='suspect'" \
  2>/dev/null | tr -d '[:space:]')

if [ "${SUSPECT:-0}" -gt 0 ]; then
  echo "::warning::${SUSPECT} suspect ledger gap(s) detected. Indexer must backfill these ranges before serving reads."
fi

echo "Indexer checkpoint recovery check complete."
echo "::endgroup::"
