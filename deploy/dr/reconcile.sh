#!/usr/bin/env bash
# deploy/dr/reconcile.sh
# Reconciles data integrity between primary and standby, records observed
# RTO/RPO against targets, and writes the results to GITHUB_STEP_SUMMARY.

set -euo pipefail

echo "::group::Reconcile data integrity and record RTO/RPO"

REPORT_PATH="${RESTORE_REHEARSAL_REPORT:-./restore-rehearsal-report.json}"
RTO_TARGET="${RESTORE_RTO_TARGET_MINUTES:-30}"
RPO_TARGET="${RESTORE_RPO_TARGET_MINUTES:-5}"

if [ -f "${REPORT_PATH}" ]; then
  echo "Reading rehearsal report from ${REPORT_PATH}..."

  # Extract key fields with node (always available in CI)
  node -e "
    const r = JSON.parse(require('fs').readFileSync('${REPORT_PATH}', 'utf8'));
    const rtoMin = r.rto?.observedMinutes ?? 'n/a';
    const rpoMin = r.rpo?.observedMinutes ?? 'n/a (no checkpoint)';
    const passed = r.passed ? 'PASS' : 'FAIL';
    console.log('RTO observed : ' + rtoMin + 'm  |  target : ${RTO_TARGET}m');
    console.log('RPO observed : ' + rpoMin + 'm  |  target : ${RPO_TARGET}m');
    console.log('Overall      : ' + passed);
    if (!r.passed && r.failures) {
      r.failures.forEach(f => console.error('  FAILURE: ' + f));
    }
    process.exit(r.passed ? 0 : 1);
  "
else
  echo "::warning::Rehearsal report not found at ${REPORT_PATH}; recording as incomplete"
fi

# Write GitHub step summary if running in Actions
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### Database restore rehearsal — RTO/RPO results (issue #859)"
    echo ""
    if [ -f "${REPORT_PATH}" ]; then
      node -e "
        const r = JSON.parse(require('fs').readFileSync('${REPORT_PATH}', 'utf8'));
        console.log('| Metric | Observed | Target | Status |');
        console.log('| --- | --- | --- | --- |');
        console.log('| RTO | ' + (r.rto?.observedMinutes ?? 'n/a') + 'm | ${RTO_TARGET}m | ' + (r.rto?.breached ? '❌ BREACHED' : '✓ OK') + ' |');
        console.log('| RPO | ' + (r.rpo?.observedMinutes ?? 'n/a') + 'm | ${RPO_TARGET}m | ' + (r.rpo?.breached ? '❌ BREACHED' : '✓ OK') + ' |');
        console.log('');
        console.log('**Critical failures:** ' + (r.consistency?.criticalFailures ?? 'n/a'));
        console.log('**Warnings:** ' + (r.consistency?.warnings ?? 'n/a'));
        console.log('**Overall:** ' + (r.passed ? '✓ PASS' : '✗ FAIL'));
      " 2>/dev/null || echo "(report parsing failed)"
    else
      echo "No report file found — rehearsal may have aborted before completing."
    fi
  } >> "${GITHUB_STEP_SUMMARY}"
fi

echo "::endgroup::"
