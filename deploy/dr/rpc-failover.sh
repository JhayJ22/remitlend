#!/usr/bin/env bash
# deploy/dr/rpc-failover.sh
# Records that the standby Soroban RPC endpoint should be used.

set -euo pipefail

echo "::group::Fail over Soroban RPC endpoint"

STANDBY_RPC="${DR_STANDBY_STELLAR_RPC_URL:-}"

if [ -z "${STANDBY_RPC}" ]; then
  echo "::warning::DR_STANDBY_STELLAR_RPC_URL is not set; using existing STELLAR_RPC_URL as standby RPC"
  echo "In a real DR scenario, set DR_STANDBY_STELLAR_RPC_URL to the standby provider endpoint."
else
  echo "Standby RPC endpoint: ${STANDBY_RPC}"
  echo "In a real DR scenario, update application config to point STELLAR_RPC_URL at this endpoint."
fi

echo "RPC failover step complete."
echo "::endgroup::"
