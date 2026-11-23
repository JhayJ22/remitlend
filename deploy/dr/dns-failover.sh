#!/usr/bin/env bash
# deploy/dr/dns-failover.sh
# Records DNS/routing change to point traffic at the standby region.

set -euo pipefail

echo "::group::Apply DNS/routing change to standby"

echo "In a real DR scenario, update DNS records / load-balancer rules to"
echo "point api.remitlend.com at the standby region endpoint."
echo ""
echo "This step is recorded as complete for the CI drill. No production traffic"
echo "will be sent during this rehearsal."
echo "::endgroup::"
