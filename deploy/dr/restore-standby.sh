#!/usr/bin/env bash
# deploy/dr/restore-standby.sh — issue #859
#
# Restores a sanitized database snapshot into the standby/isolated
# environment and runs all application-level consistency checks.
# Called by the dr-drill CI job in deploy-staging.yml and also by the
# reusable-restore-rehearsal.yml workflow.
#
# Never uses production data. The snapshot must be labelled 'sanitized'
# (PII fields anonymised) before this script is called.
#
# Required env vars:
#   REHEARSAL_DB_URL            Target isolated postgres DB URL
#   BACKUP_S3_BUCKET            S3 bucket (or use RESTORE_DUMP_FILE)
#   RESTORE_RTO_TARGET_MINUTES  (optional, default 30)
#   RESTORE_RPO_TARGET_MINUTES  (optional, default 5)
#   RESTORE_REHEARSAL_REPORT    (optional) output path for JSON report
#
# Exits non-zero when any critical consistency check fails or RTO/RPO
# targets are breached.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

echo "::group::Database restore rehearsal (issue #859)"
echo "Repo root: ${REPO_ROOT}"
echo "RTO target: ${RESTORE_RTO_TARGET_MINUTES:-30}m"
echo "RPO target: ${RESTORE_RPO_TARGET_MINUTES:-5}m"
echo "Target DB : ${REHEARSAL_DB_URL:-postgres://postgres:postgres@localhost:5432/restore_rehearsal}"

# Default report path inside the CI workspace so the upload step finds it.
export RESTORE_REHEARSAL_REPORT="${RESTORE_REHEARSAL_REPORT:-${REPO_ROOT}/restore-rehearsal-report.json}"

# Install Node dependencies if the scripts/ directory has a lockfile
if [ -f "${REPO_ROOT}/scripts/package-lock.json" ]; then
  cd "${REPO_ROOT}/scripts"
  npm ci --silent
fi

# Install backend deps if not already installed (needed for tsx / migration runner)
if [ ! -d "${REPO_ROOT}/backend/node_modules" ]; then
  echo "Installing backend dependencies..."
  cd "${REPO_ROOT}/backend"
  npm ci --silent
fi

cd "${REPO_ROOT}"

echo "Running restore rehearsal script..."
node scripts/restore-rehearsal.mjs

EXIT_CODE=$?

echo "::endgroup::"
echo "Restore rehearsal exit code: ${EXIT_CODE}"
exit ${EXIT_CODE}
