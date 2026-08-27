#!/bin/bash
# Attempt to optimize WASM binary sizes using wasm-opt
# Generates optimization report and applies suggested optimizations

set -euo pipefail

WASM_DIR="${1:-./target/wasm32-unknown-unknown/release}"
OUTPUT_DIR="${2:-.wasm-optimized}"

if [ ! -d "$WASM_DIR" ]; then
    echo "::error::WASM directory not found: $WASM_DIR"
    exit 1
fi

# Check if wasm-opt is available
if ! command -v wasm-opt &> /dev/null; then
    echo "::warning::wasm-opt not found. Install from https://github.com/WebAssembly/binaryen/releases"
    echo "::warning::Skipping automatic optimization. Manual review recommended."
    exit 0
fi

mkdir -p "$OUTPUT_DIR"

echo "=== WASM Binary Optimization Report ==="
echo ""
echo "Running wasm-opt on all WASM binaries..."
echo ""

TOTAL_ORIGINAL=0
TOTAL_OPTIMIZED=0
TOTAL_SAVINGS=0

for wasm_file in "$WASM_DIR"/*.wasm; do
    if [ ! -f "$wasm_file" ]; then
        continue
    fi

    contract_name=$(basename "$wasm_file" .wasm)
    original_size=$(stat -c%s "$wasm_file")
    optimized_file="$OUTPUT_DIR/${contract_name}-optimized.wasm"

    # Apply optimization levels progressively
    echo "Optimizing $contract_name..."

    # First pass: level O3 (aggressive optimization)
    wasm-opt -O3 "$wasm_file" -o "$optimized_file" 2>/dev/null || {
        # Fallback to O2 if O3 fails
        wasm-opt -O2 "$wasm_file" -o "$optimized_file" 2>/dev/null || {
            # Fallback to O1
            wasm-opt -O1 "$wasm_file" -o "$optimized_file" 2>/dev/null || {
                echo "  Warning: Could not optimize $contract_name"
                continue
            }
        }
    }

    optimized_size=$(stat -c%s "$optimized_file")
    savings=$((original_size - optimized_size))
    savings_pct=0
    if [ "$original_size" -gt 0 ]; then
        savings_pct=$(( (savings * 100) / original_size ))
    fi

    echo "  Original:   $original_size bytes"
    echo "  Optimized:  $optimized_size bytes"
    echo "  Savings:    $savings bytes ($savings_pct%)"
    echo ""

    TOTAL_ORIGINAL=$((TOTAL_ORIGINAL + original_size))
    TOTAL_OPTIMIZED=$((TOTAL_OPTIMIZED + optimized_size))
    TOTAL_SAVINGS=$((TOTAL_SAVINGS + savings))
done

echo "=== Optimization Summary ==="
echo "Total original size:  $TOTAL_ORIGINAL bytes"
echo "Total optimized size: $TOTAL_OPTIMIZED bytes"
echo "Total savings:        $TOTAL_SAVINGS bytes"

if [ "$TOTAL_ORIGINAL" -gt 0 ]; then
    total_savings_pct=$(( (TOTAL_SAVINGS * 100) / TOTAL_ORIGINAL ))
    echo "Overall reduction:    $total_savings_pct%"
    echo ""
    echo "Optimized binaries available in: $OUTPUT_DIR"
    echo ""
    echo "To apply optimizations:"
    echo "  cp $OUTPUT_DIR/*.wasm $WASM_DIR/"
    echo ""
fi

if [ "$TOTAL_SAVINGS" -gt 0 ]; then
    echo "✓ Optimization opportunities available"
    exit 0
else
    echo "✓ Binaries already well-optimized"
    exit 0
fi
