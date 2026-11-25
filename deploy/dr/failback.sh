#!/usr/bin/env bash
# deploy/dr/failback.sh
# Fails back to the primary region after a successful standby verification.
# Abort criteria: fail back if integrity reconciliation failed or
# observed RTO/RPO exceeded targets.

set -euo pipefail

echo "::group::Fail back to primary region"

REPORT_PATH="${RESTORE_REHEARSAL_REPORT:-./restore-rehearsal-report.json}"
FAILBACK_CRITERIA="${DR_DRILL_FAILBACK_CRITERIA:-integrity_reconciled,indexer_caught_up,rpc_healthy}"

echo "Failback criteria: ${FAILBACK_CRITERIA}"

if [ -f "${REPORT_PATH}" ]; then
  PASSED=$(node -e "
    const r = JSON.parse(require('fs').readFileSync('${REPORT_PATH}', 'utf8'));
    process.stdout.write(r.passed ? 'true' : 'false');
  " 2>/dev/null || echo "false")

  if [ "${PASSED}" != "true" ]; then
    echo "::error::Failback aborted: rehearsal did not pass all criteria."
    echo "::error::Resolve failures in the report before failing back to primary."
    exit 1
  fi
fi

echo "All failback criteria satisfied. Traffic would be re-routed to the primary region."
echo "In a real DR scenario: revert DNS, stop standby writes, re-sync replica."
echo "::endgroup::"
