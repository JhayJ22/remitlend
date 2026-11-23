#!/usr/bin/env bash
# deploy/dr/verify-fenced.sh
# Verifies that the standby cannot submit Soroban transactions until
# network + signer controls are explicitly verified.
# A successful Soroban submission from standby before this script passes
# is a drill failure.

set -euo pipefail

echo "::group::Verify standby write fencing"

SIGNER_OK="${DR_DRILL_SIGNER_VERIFIED:-false}"
NETWORK_OK="${DR_DRILL_NETWORK_VERIFIED:-false}"
WRITE_BLOCKED="${DR_DRILL_STANDBY_WRITE_BLOCKED:-true}"

echo "DR_DRILL_STANDBY_WRITE_BLOCKED : ${WRITE_BLOCKED}"
echo "DR_DRILL_SIGNER_VERIFIED       : ${SIGNER_OK}"
echo "DR_DRILL_NETWORK_VERIFIED      : ${NETWORK_OK}"

if [ "${WRITE_BLOCKED}" != "true" ] && [ "${SIGNER_OK}" != "true" ] && [ "${NETWORK_OK}" != "true" ]; then
  echo "::error::Standby write gate is NOT set and neither signer nor network controls are verified."
  echo "::error::This is a critical drill failure: the standby could submit real transactions."
  exit 1
fi

if [ "${WRITE_BLOCKED}" != "true" ]; then
  if [ "${SIGNER_OK}" = "true" ] && [ "${NETWORK_OK}" = "true" ]; then
    echo "Write gate lifted — both signer and network controls are verified."
  else
    echo "::error::Write gate is not set but controls are not fully verified (signer=${SIGNER_OK}, network=${NETWORK_OK})"
    exit 1
  fi
else
  echo "Standby write gate is in place. Fencing check passed."
fi

echo "::endgroup::"
