#!/bin/bash
# Check for WASM size regression compared to base branch
# Fails if any contract increased >5% in size

set -euo pipefail

BASE_BRANCH="${1:-origin/main}"
WASM_DIR="${2:-./target/wasm32-unknown-unknown/release}"
MAX_REGRESSION_PCT=5

if [ ! -d "$WASM_DIR" ]; then
    echo "::error::WASM directory not found: $WASM_DIR"
    exit 1
fi

# Try to fetch base branch if not available
if ! git rev-parse "$BASE_BRANCH" >/dev/null 2>&1; then
    echo "Fetching base branch: $BASE_BRANCH"
    git fetch -q origin "${BASE_BRANCH#origin/}" || true
fi

# Build a temporary list of base sizes
echo "Computing size baseline from $BASE_BRANCH..."
BASE_SIZES=$(mktemp)
trap "rm -f '$BASE_SIZES'" EXIT

# Get the base commit
BASE_COMMIT=$(git merge-base HEAD "$BASE_BRANCH" 2>/dev/null || git rev-parse "$BASE_BRANCH")

# Try to get sizes from the base commit
if git show "$BASE_COMMIT:contracts/Cargo.toml" >/dev/null 2>&1; then
    git show "$BASE_COMMIT:.github/workflows/ci.yml" | \
        grep -A 5 "Build contracts for wasm32" | \
        grep -o "'.*\.wasm'" | tr -d "'" > "$BASE_SIZES" 2>/dev/null || true
fi

REGRESSION_FOUND=0

for wasm_file in "$WASM_DIR"/*.wasm; do
    if [ ! -f "$wasm_file" ]; then
        continue
    fi

    contract_name=$(basename "$wasm_file" .wasm)
    current_size=$(stat -c%s "$wasm_file")
    current_size_kib=$(( (current_size + 1023) / 1024 ))

    echo "Contract: $contract_name"
    echo "  Current size: $current_size bytes ($current_size_kib KiB)"

    # Try to get previous size from git
    if git show "$BASE_COMMIT:contracts/target/wasm32-unknown-unknown/release/$contract_name.wasm" >/dev/null 2>&1; then
        base_wasm=$(mktemp)
        trap "rm -f '$base_wasm'" EXIT
        git show "$BASE_COMMIT:contracts/target/wasm32-unknown-unknown/release/$contract_name.wasm" > "$base_wasm"
        base_size=$(stat -c%s "$base_wasm")
        base_size_kib=$(( (base_size + 1023) / 1024 ))

        # Calculate percentage change
        size_diff=$((current_size - base_size))
        if [ "$base_size" -gt 0 ]; then
            pct_change=$(( (size_diff * 100) / base_size ))
        else
            pct_change=0
        fi

        echo "  Base size:    $base_size bytes ($base_size_kib KiB)"
        echo "  Change:       $size_diff bytes ($pct_change%)"

        if [ "$pct_change" -gt "$MAX_REGRESSION_PCT" ]; then
            echo "  ::error::Size regression detected! Increased $pct_change% (max $MAX_REGRESSION_PCT%)"
            REGRESSION_FOUND=1
        elif [ "$pct_change" -lt "-$MAX_REGRESSION_PCT" ]; then
            echo "  ✓ Size optimized! Decreased $((pct_change * -1))%"
        fi

        rm -f "$base_wasm"
    fi

    echo ""
done

if [ "$REGRESSION_FOUND" -eq 1 ]; then
    echo "::error::Size regression detected. Review optimization strategies in contracts/WASM_OPTIMIZATION.md"
    exit 1
fi

echo "✓ All contracts within acceptable size change threshold ($MAX_REGRESSION_PCT%)"
exit 0
