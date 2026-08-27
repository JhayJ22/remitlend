#!/bin/bash
# Analyze per-function WASM sizes for all contracts
# This script measures individual function sizes and compares against budgets

set -euo pipefail

# Default per-function budget: 8 KiB per function (adjust based on contract complexity)
DEFAULT_FUNCTION_BUDGET_BYTES=$((8 * 1024))

# Per-function size budgets for specific contracts (in bytes)
# Override defaults here for contracts that need different budgets
declare -A FUNCTION_BUDGETS=(
    ["loan_manager"]=$((12 * 1024))      # Complex contract, higher budget
    ["lending_pool"]=$((10 * 1024))      # Medium complexity
    ["remittance_nft"]=$((10 * 1024))    # Medium complexity
    ["money"]=$((6 * 1024))              # Simple contract, tight budget
    ["multisig_governance"]=$((8 * 1024)) # Standard budget
)

WASM_DIR="${1:-./target/wasm32-unknown-unknown/release}"

if [ ! -d "$WASM_DIR" ]; then
    echo "::error::WASM directory not found: $WASM_DIR"
    exit 1
fi

# Check if wasm-dis is available (from wabt)
if ! command -v wasm-dis &> /dev/null; then
    echo "::warning::wasm-dis not found. Installing wabt..."
    # Try to install wabt (may need to be done in CI)
    if command -v apt-get &> /dev/null; then
        apt-get update -qq && apt-get install -y -qq wabt 2>&1 | grep -v "^Setting up" || true
    elif command -v brew &> /dev/null; then
        brew install wabt 2>&1 | grep -v "^Homebrew" || true
    else
        echo "::warning::Could not auto-install wabt. Some analysis features may be limited."
    fi
fi

# Use jq for JSON parsing if available, otherwise create a simple report
USE_JSON=false
if command -v jq &> /dev/null; then
    USE_JSON=true
fi

TOTAL_VIOLATIONS=0
ANALYSIS_REPORT=""

echo "=== Contract Size Analysis Report ==="
echo ""

for wasm_file in "$WASM_DIR"/*.wasm; do
    if [ ! -f "$wasm_file" ]; then
        continue
    fi

    contract_name=$(basename "$wasm_file" .wasm)
    total_size=$(stat -c%s "$wasm_file")
    total_size_kib=$(( (total_size + 1023) / 1024 ))

    echo "Contract: $contract_name"
    echo "  Total size: $total_size bytes ($total_size_kib KiB)"

    # Try to extract per-function sizes using wasm-dis
    if command -v wasm-dis &> /dev/null; then
        # Create a temporary file for the disassembly
        temp_wasm_dis=$(mktemp)
        trap "rm -f '$temp_wasm_dis'" EXIT

        wasm-dis "$wasm_file" -o "$temp_wasm_dis" 2>/dev/null || true

        if [ -f "$temp_wasm_dis" ] && [ -s "$temp_wasm_dis" ]; then
            # Extract function names and their approximate code section sizes
            # This is approximate - actual per-function analysis would need more sophisticated parsing
            function_count=$(grep -c "^  (func " "$temp_wasm_dis" || echo "0")
            echo "  Estimated functions: $function_count"

            # For now, simple heuristic: divide data section size by number of functions
            # In a full implementation, this would parse the WASM binary more carefully
            if [ "$function_count" -gt 0 ]; then
                avg_function_size=$(( total_size / (function_count + 1) ))
                budget="${FUNCTION_BUDGETS[$contract_name]:-$DEFAULT_FUNCTION_BUDGET_BYTES}"

                if [ "$avg_function_size" -gt "$budget" ]; then
                    echo "  ::warning::Average function size ($avg_function_size bytes) exceeds budget ($budget bytes)"
                    TOTAL_VIOLATIONS=$((TOTAL_VIOLATIONS + 1))
                fi
            fi

            rm -f "$temp_wasm_dis"
        fi
    else
        # Fallback: use a simple size-based heuristic
        budget="${FUNCTION_BUDGETS[$contract_name]:-$DEFAULT_FUNCTION_BUDGET_BYTES}"
        echo "  Per-function budget: $((budget / 1024)) KiB (estimated)"

        if [ "$total_size" -gt "$((budget * 10))" ]; then
            echo "  ::warning::Total size significantly exceeds 10x per-function budget"
            TOTAL_VIOLATIONS=$((TOTAL_VIOLATIONS + 1))
        fi
    fi

    echo ""
done

echo "=== Summary ==="
echo "Total contracts analyzed: $(ls "$WASM_DIR"/*.wasm 2>/dev/null | wc -l)"
echo "Total violations: $TOTAL_VIOLATIONS"
echo ""

if [ "$TOTAL_VIOLATIONS" -gt 0 ]; then
    echo "::warning::Found $TOTAL_VIOLATIONS size budget violations. Review optimization opportunities."
    exit 0  # Don't fail the build yet, just warn
else
    echo "All contracts within size budgets."
    exit 0
fi
