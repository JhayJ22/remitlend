#!/bin/bash
# Self-test for check-wasm-size-budgets.sh: passes within budget, fails when a budget is inflated down.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
d=$(mktemp -d); trap 'rm -rf "$d"' EXIT
head -c 1000 /dev/zero > "$d/demo.wasm"
echo '{"wasm_budgets_bytes":{"demo":1100}}' > "$d/b.json"
bash "$here/check-wasm-size-budgets.sh" "$d" "$d/b.json" >/dev/null
echo '{"wasm_budgets_bytes":{"demo":999}}' > "$d/b.json"
if bash "$here/check-wasm-size-budgets.sh" "$d" "$d/b.json" >/dev/null; then
  echo "FAIL: over-budget wasm was not rejected"; exit 1
fi
echo '{"wasm_budgets_bytes":{}}' > "$d/b.json"
if bash "$here/check-wasm-size-budgets.sh" "$d" "$d/b.json" >/dev/null; then
  echo "FAIL: missing entry was not rejected"; exit 1
fi
bash "$here/check-wasm-size-budgets.sh" --update "$d" "$d/b.json" >/dev/null
[ "$(jq '.wasm_budgets_bytes.demo' "$d/b.json")" = 1100 ]
echo "OK"
