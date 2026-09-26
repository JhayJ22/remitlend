#!/bin/bash
# verify-wasm-hashes.sh — Reproducible WASM artifact verification (#410)
#
# Usage:
#   Generate (record) a new baseline:
#     bash scripts/verify-wasm-hashes.sh --generate <wasm_dir> [output_file]
#
#   Verify artifacts against an existing baseline:
#     bash scripts/verify-wasm-hashes.sh <wasm_dir> [hash_file]
#
# The hash file is a newline-separated list of "<sha256>  <filename>" pairs
# produced by sha256sum, committed alongside the WASM artifacts so that any
# rebuild on any machine can be compared against the canonical build.
#
# Exit codes:
#   0  All hashes match (or baseline generated successfully)
#   1  One or more WASM files are missing, unexpected, or have changed hash
#   2  Usage error

set -euo pipefail

# ── Constants ────────────────────────────────────────────────────────────────

DEFAULT_HASH_FILE="contracts/wasm-hashes.sha256"
SCRIPT_NAME="$(basename "$0")"

# ── Helpers ──────────────────────────────────────────────────────────────────

usage() {
  cat >&2 <<EOF
Usage:
  $SCRIPT_NAME --generate <wasm_dir> [output_file]
  $SCRIPT_NAME           <wasm_dir> [hash_file]

Options:
  --generate   Compute and write a fresh SHA-256 baseline (commit the result).
  <wasm_dir>   Directory containing *.wasm files (e.g. contracts/target/wasm32-unknown-unknown/release).
  [hash_file]  Path to the .sha256 file; defaults to $DEFAULT_HASH_FILE.

Environment (CI):
  WASM_DIR     Overrides <wasm_dir> positional argument.
  HASH_FILE    Overrides [hash_file] positional argument.
EOF
  exit 2
}

info()    { echo "[verify-wasm] $*"; }
warn()    { echo "::warning::$*"; }
error()   { echo "::error::$*" >&2; }

# ── Argument parsing ─────────────────────────────────────────────────────────

GENERATE_MODE=false

if [[ "${1:-}" == "--generate" ]]; then
  GENERATE_MODE=true
  shift
fi

WASM_DIR="${1:-${WASM_DIR:-}}"
HASH_FILE="${2:-${HASH_FILE:-$DEFAULT_HASH_FILE}}"

if [[ -z "$WASM_DIR" ]]; then
  error "Missing required argument: <wasm_dir>"
  usage
fi

if [[ ! -d "$WASM_DIR" ]]; then
  error "WASM directory not found: $WASM_DIR"
  exit 1
fi

# ── Collect WASM files ───────────────────────────────────────────────────────

# Use a glob that works on both Linux (GNU) and macOS (BSD) with bash
shopt -s nullglob
wasm_files=("$WASM_DIR"/*.wasm)
shopt -u nullglob

if [[ "${#wasm_files[@]}" -eq 0 ]]; then
  error "No *.wasm files found in $WASM_DIR"
  exit 1
fi

info "Found ${#wasm_files[@]} WASM artifact(s) in $WASM_DIR"

# ── Generate mode ────────────────────────────────────────────────────────────

if [[ "$GENERATE_MODE" == "true" ]]; then
  info "Generating SHA-256 baseline → $HASH_FILE"

  # Build the hash file in a reproducible order (sort by filename)
  TMP_HASH="$(mktemp)"
  trap 'rm -f "$TMP_HASH"' EXIT

  for wasm in "${wasm_files[@]}"; do
    sha256sum "$wasm" >> "$TMP_HASH"
  done

  # Sort by filename (second column) for determinism
  sort -k2 "$TMP_HASH" > "$HASH_FILE"

  info "Baseline written to $HASH_FILE:"
  cat "$HASH_FILE"
  info "Commit this file alongside your WASM artifacts."
  exit 0
fi

# ── Verify mode ──────────────────────────────────────────────────────────────

if [[ ! -f "$HASH_FILE" ]]; then
  error "Hash baseline not found: $HASH_FILE"
  error "Run with --generate to create a new baseline."
  exit 1
fi

info "Verifying WASM artifacts against baseline: $HASH_FILE"

FAILURES=0
CHECKED=0

# Build a lookup map: filename → expected hash
declare -A EXPECTED_HASHES

while IFS= read -r line; do
  # Lines produced by sha256sum: "<hash>  <path>"
  expected_hash="${line%%  *}"
  artifact_path="${line#*  }"
  artifact_name="$(basename "$artifact_path")"
  EXPECTED_HASHES["$artifact_name"]="$expected_hash"
done < "$HASH_FILE"

# --- Check each WASM present on disk against expected hashes ---

for wasm in "${wasm_files[@]}"; do
  name="$(basename "$wasm")"
  actual_hash="$(sha256sum "$wasm" | awk '{print $1}')"

  if [[ -z "${EXPECTED_HASHES[$name]+_}" ]]; then
    warn "Unexpected WASM artifact (not in baseline): $name"
    warn "  Run verify-wasm-hashes.sh --generate to update the baseline after a deliberate change."
    FAILURES=$((FAILURES + 1))
    continue
  fi

  expected_hash="${EXPECTED_HASHES[$name]}"

  if [[ "$actual_hash" == "$expected_hash" ]]; then
    info "✓  $name  ($actual_hash)"
  else
    error "Hash mismatch for $name"
    error "  expected: $expected_hash"
    error "  actual:   $actual_hash"
    error "  The compiled artifact differs from the committed baseline."
    error "  If this is a deliberate change, regenerate the baseline:"
    error "    bash scripts/verify-wasm-hashes.sh --generate <wasm_dir>"
    FAILURES=$((FAILURES + 1))
  fi

  CHECKED=$((CHECKED + 1))
  unset 'EXPECTED_HASHES[$name]'
done

# --- Check for artifacts listed in baseline but missing from the build ---

for missing_name in "${!EXPECTED_HASHES[@]}"; do
  error "Expected WASM artifact is missing from build: $missing_name"
  error "  Baseline expects: ${EXPECTED_HASHES[$missing_name]}"
  FAILURES=$((FAILURES + 1))
done

# ── Result ───────────────────────────────────────────────────────────────────

if [[ "$FAILURES" -gt 0 ]]; then
  error "WASM verification failed: $FAILURES issue(s) found."
  exit 1
fi

info "All $CHECKED WASM artifact(s) verified successfully."
exit 0
