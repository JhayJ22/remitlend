#!/bin/bash
# Enforce per-contract WASM size budgets from contracts/size-budgets.json.
#
# Usage:
#   check-wasm-size-budgets.sh [WASM_DIR] [BUDGETS_JSON]            # check (fails on violation)
#   check-wasm-size-budgets.sh --update [WASM_DIR] [BUDGETS_JSON]   # rewrite budgets = size + 10%
#
# Fails when a built .wasm is over its `wasm_budgets_bytes` entry, or has no entry.
set -euo pipefail

UPDATE=0
if [ "${1:-}" = "--update" ]; then UPDATE=1; shift; fi
WASM_DIR="${1:-./target/wasm32-unknown-unknown/release}"
BUDGETS="${2:-./size-budgets.json}"
TOLERANCE_PCT=10

shopt -s nullglob
wasm_files=("$WASM_DIR"/*.wasm)
if [ "${#wasm_files[@]}" -eq 0 ]; then
  echo "::error::No wasm artifacts found in $WASM_DIR"
  exit 1
fi

if [ "$UPDATE" -eq 1 ]; then
  tmp=$(mktemp)
  cp "$BUDGETS" "$tmp"
  for wasm in "${wasm_files[@]}"; do
    name=$(basename "$wasm" .wasm)
    size=$(stat -c%s "$wasm")
    budget=$(( size + size * TOLERANCE_PCT / 100 ))
    jq --arg n "$name" --argjson b "$budget" '.wasm_budgets_bytes[$n] = $b' "$tmp" > "$tmp.new" && mv "$tmp.new" "$tmp"
    echo "$name: size ${size} -> budget ${budget}"
  done
  mv "$tmp" "$BUDGETS"
  exit 0
fi

failed=0
for wasm in "${wasm_files[@]}"; do
  name=$(basename "$wasm" .wasm)
  actual=$(stat -c%s "$wasm")
  budget=$(jq -r --arg n "$name" '.wasm_budgets_bytes[$n] // empty' "$BUDGETS")
  if [ -z "$budget" ]; then
    echo "::error file=$wasm::No entry for '$name' in wasm_budgets_bytes ($BUDGETS)."
    failed=1
  elif [ "$actual" -gt "$budget" ]; then
    echo "::error file=$wasm::$name.wasm is ${actual} bytes, over its budget of ${budget} bytes (+$((actual - budget)))."
    failed=1
  else
    echo "$name.wasm: ${actual} bytes (budget ${budget})"
  fi
done
exit "$failed"
