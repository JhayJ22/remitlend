#!/usr/bin/env bash
# deploy/dr/start-standby.sh
# Starts standby application services with production-equivalent config.
# Called after restore-standby.sh completes.

set -euo pipefail

echo "::group::Start standby services"

# Validate that the standby write gate is still in place before starting.
if [ "${DR_DRILL_STANDBY_WRITE_BLOCKED:-true}" != "true" ]; then
  echo "::error::DR_DRILL_STANDBY_WRITE_BLOCKED must be 'true' before starting standby services"
  exit 1
fi

echo "Standby write gate is in place (DR_DRILL_STANDBY_WRITE_BLOCKED=${DR_DRILL_STANDBY_WRITE_BLOCKED})"
echo "Standby services would start here with production-equivalent config."
echo "In a real DR scenario: start the backend container against the restored DB."
echo "In CI rehearsal: the consistency checks run directly against the restored DB."
echo "::endgroup::"
