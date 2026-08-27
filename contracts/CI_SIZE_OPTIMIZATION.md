# CI-Based Contract Size Analysis and Optimization

## Overview

The CI pipeline includes automated contract size analysis and optimization checks to prevent size regressions and surface optimization opportunities. This document explains the automation and how to respond to size-related CI failures.

## CI Workflow

### Size Analysis Phase

After building contracts, the CI pipeline runs:

1. **Per-Function Analysis** (`analyze-contract-sizes.sh`)
   - Analyzes function count and average sizes
   - Compares against per-function budgets
   - Warns on budget violations but doesn't fail the build
   - Provides visibility into code composition

2. **Regression Detection** (`check-wasm-size-regression.sh`)
   - Runs only on pull requests
   - Compares current sizes against base branch (origin/main)
   - Fails if any contract size increased >5%
   - Provides detailed diff and percentage changes

3. **Optimization Report** (`optimize-wasm-sizes.sh`)
   - Runs `wasm-opt` (if available) on all binaries
   - Tests optimization levels O1, O2, O3
   - Reports potential size savings
   - Uploads report as CI artifact for review

### Size Artifacts

CI uploads optimization reports containing:
- Original binary sizes
- Optimized binary sizes
- Per-contract savings analysis
- Optimization recommendations

Access via GitHub Actions: **Artifacts** → `wasm-optimization-report`

## Responding to CI Failures

### Size Regression Detected (>5% increase)

When a contract increases more than 5%:

**Steps:**
1. Review the CI failure message for which contract regressed
2. Identify the recent changes causing the increase
3. Apply one or more optimization strategies

**Optimization Strategies:**

```bash
# 1. Use pre-built optimization tool
./scripts/optimize-wasm-sizes.sh target/wasm32-unknown-unknown/release

# 2. Review and apply code changes from WASM_OPTIMIZATION.md
# - Reduce data structures
# - Consolidate functions
# - Optimize storage patterns
# - Simplify error handling
```

**To Compare Sizes Locally:**

```bash
# Before changes
ls -lh target/wasm32-unknown-unknown/release/*.wasm

# Make optimizations...

# Rebuild
cargo build --target wasm32-unknown-unknown --release

# After changes
ls -lh target/wasm32-unknown-unknown/release/*.wasm
```

### Common Causes and Fixes

| Issue | Cause | Solution |
|-------|-------|----------|
| Slow regression over time | Feature creep, new dependencies | Review WASM_OPTIMIZATION.md strategies |
| Sudden large increase | New heavy dependency | Remove unused imports, consider alternatives |
| Subtle increase in one function | Code duplication | Extract common logic into helpers |
| Overall bloat | Monolithic implementation | Separate concerns into focused functions |

## Build Configuration

### Rust Compiler Settings

The `contracts/Cargo.toml` defines release profile for optimal size:

```toml
[profile.release]
opt-level = "z"           # Optimize for size (not speed)
overflow-checks = false   # Disable runtime checks
debug = 0                 # Strip debug symbols
strip = "symbols"         # Remove all symbols
debug-assertions = false  # Remove assertions
panic = "abort"           # Use abort instead of unwind
codegen-units = 1         # Maximum optimization (slower compile)
lto = true                # Link-time optimization
```

**These settings are already configured.** Do not change without justification.

### WASM-Specific Optimization

#### Using wasm-opt

The `wasm-opt` tool from Binaryen provides post-compilation optimization:

```bash
# Install (macOS)
brew install binaryen

# Install (Linux)
sudo apt-get install binaryen

# Or download from: https://github.com/WebAssembly/binaryen/releases
```

**Optimization levels:**
- `-O1`: Basic optimizations
- `-O2`: Moderate optimizations (recommended default)
- `-O3`: Aggressive optimizations
- `-Oz`: Size-focused optimizations (extreme)
- `-Os`: Balanced size/speed

**CI applies O3 by default, falling back to O2 or O1 if needed.**

#### Size Reduction Techniques

1. **Code Removal**
   ```bash
   wasm-opt -O3 --enable-bulk-memory input.wasm -o output.wasm
   ```

2. **Constant Propagation**
   ```bash
   wasm-opt -O3 --enable-simd input.wasm -o output.wasm
   ```

3. **Function Inlining**
   ```bash
   wasm-opt -O3 --inline-functions input.wasm -o output.wasm
   ```

## Size Budget Enforcement

### Total Budget
- **Per-contract limit**: 256 KiB
- **Enforced by**: CI build step, hard failure if exceeded
- **Rationale**: Ensures contract deployability on Stellar

### Per-Function Budget
- **Default**: 8 KiB per function
- **Contract-specific overrides**: See `size-budgets.json`
- **Enforced by**: Analysis phase, warning-only (not hard failure)
- **Rationale**: Guides refactoring decisions and code quality

### Regression Threshold
- **Max increase**: 5% per commit
- **Enforced by**: `check-wasm-size-regression.sh` on PRs
- **Rationale**: Prevents death by a thousand cuts

## Viewing Reports

### In GitHub Actions

1. Go to **Actions** → latest workflow run
2. Select the **contracts** job
3. Scroll to **Upload size analysis and optimization report**
4. Download `wasm-optimization-report` artifact
5. Extract and review:
   - `.wasm-optimized/` - Optimized binaries
   - `size-budgets.json` - Current budgets

### Interpreting the Report

```
Contract: loan_manager
  Current size: 247,000 bytes (241 KiB)
  Original:    247,000 bytes (241 KiB)
  Optimized:   238,000 bytes (232 KiB)
  Savings:     9,000 bytes (4%)
```

**Interpretation**: The `loan_manager` contract has 4% optimization potential.

## CI-Side Analysis Details

### Regression Check Failure Message

```
::error::Size regression detected! Increased 6% (max 5%)
::error::Size regression detected. Review optimization strategies in contracts/WASM_OPTIMIZATION.md
```

**What to do:**
1. Check which files changed in your PR
2. Review changes for unnecessary additions
3. Apply optimization strategies from WASM_OPTIMIZATION.md
4. Rebuild and re-push (CI will re-check)

### Optimization Report Format

```
=== WASM Binary Optimization Report ===

Optimizing loan_manager...
  Original:   247000 bytes
  Optimized:  238000 bytes
  Savings:    9000 bytes (4%)

=== Optimization Summary ===
Total original size:  1,200,000 bytes
Total optimized size: 1,165,000 bytes
Total savings:        35,000 bytes
Overall reduction:    3%

Optimized binaries available in: .wasm-optimized/
```

## Local Development Workflow

### Check Your Changes Locally

```bash
# Before committing
cd contracts
cargo build --target wasm32-unknown-unknown --release

# Analyze sizes
../scripts/analyze-contract-sizes.sh ./target/wasm32-unknown-unknown/release

# Generate optimization report (requires wasm-opt)
../scripts/optimize-wasm-sizes.sh ./target/wasm32-unknown-unknown/release
```

### Catch Regressions Early

```bash
# Before opening PR, check vs. main
git fetch origin main
../scripts/check-wasm-size-regression.sh origin/main ./target/wasm32-unknown-unknown/release
```

### Size-Aware Development

Every commit:
1. **Before**: Note current sizes
2. **After change**: Rebuild and compare
3. **If regression**: Optimize before committing

```bash
# Check before
ls -lh target/wasm32-unknown-unknown/release/*.wasm | awk '{print $9, $5}'

# Make changes...

# Rebuild
cargo build --target wasm32-unknown-unknown --release

# Check after
ls -lh target/wasm32-unknown-unknown/release/*.wasm | awk '{print $9, $5}'
```

## Troubleshooting

### "wasm-opt not found" Warning

**Cause**: The Binaryen toolchain is not installed in CI runner.

**Solution**: The CI gracefully degrades—analysis still runs, optimization is skipped.

**To fix**: Install locally and test optimization before pushing.

### Size Increases Unexpectedly

**Check:**
1. New dependencies in Cargo.toml
2. New error variants
3. New functions
4. Increased function complexity

**Review:**
- Run `cargo bloat --target wasm32-unknown-unknown --release`
- Identify largest functions
- Apply consolidation or removal strategies

### Regression Threshold Too Strict

**If 5% is too strict for your change:**
1. Provide detailed justification in PR comment
2. Include optimization efforts already attempted
3. Request exception (rare, requires approval)

**Remember**: 5% is empirically sustainable for large codebases.

## Best Practices

1. **Monitor sizes over time**
   - Track size evolution in PR descriptions
   - Notice patterns in growth

2. **Optimize proactively**
   - Don't wait for CI failure
   - Analyze before committing

3. **Review optimization potential**
   - Check CI artifact reports
   - Implement high-impact optimizations

4. **Document intentional increases**
   - If size increase is necessary, explain why
   - Provide offset optimizations elsewhere

5. **Use feature flags**
   - For optional functionality
   - Reduces baseline binary size

## Future Enhancements

- [ ] Per-function size tracking (requires WASM parsing)
- [ ] Historical trend analysis
- [ ] Automated optimization suggestions
- [ ] Size budget adjustment based on complexity metrics
- [ ] Integration with performance benchmarks
- [ ] Automated dependency audit for size impact
