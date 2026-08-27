# WASM Contract Size Optimization Guide

## Overview

This guide documents strategies for optimizing WebAssembly contract sizes. The project maintains per-contract and per-function size budgets to ensure efficient resource usage and prevent bloat.

### Current Budgets

- **Total budget per contract**: 256 KiB
- **Per-function budgets**: 
  - `loan_manager`: 12 KiB (complex contract)
  - `lending_pool`: 10 KiB (medium complexity)
  - `remittance_nft`: 10 KiB (medium complexity)
  - `money`: 6 KiB (simple contract)
  - `multisig_governance`: 8 KiB (standard)
  - Default: 8 KiB per function

## Optimization Strategies

### 1. Reduce Data Structures

**Problem**: Unnecessarily large data structures increase code size.

**Solutions**:
- Use `u32` instead of `u64` where possible
- Use enum variants instead of separate types
- Combine related fields into structs to enable shared code paths
- Example: Instead of separate `bool` fields, use a bitfield

### 2. Consolidate Similar Functions

**Problem**: Multiple similar functions with slight variations bloat the code.

**Solutions**:
- Extract common logic into helper functions
- Use generic functions with type parameters
- Use builder patterns instead of multiple constructor variants
- Consolidate validation logic into shared functions

```rust
// Before: Multiple similar functions
pub fn transfer_tokens_a(from: Address, to: Address, amount: i128) { ... }
pub fn transfer_tokens_b(from: Address, to: Address, amount: i128, fee: i128) { ... }

// After: Single function with optional params
fn transfer_tokens(from: Address, to: Address, amount: i128, fee: Option<i128>) { ... }
```

### 3. Lazy Initialization and Optional Features

**Problem**: All code is compiled even if rarely used.

**Solutions**:
- Use feature flags for optional functionality
- Defer expensive computations to only when needed
- Separate concerns into different contract modules

### 4. Optimize Storage Access Patterns

**Problem**: Repeated storage access generates more code.

**Solutions**:
- Batch storage operations
- Use local variables to cache computed values
- Minimize number of distinct storage keys
- Use smaller types for keys (e.g., `Symbol` instead of `String`)

```rust
// Before: Multiple lookups
let val1 = env.storage().persistent().get(&key1);
let val2 = env.storage().persistent().get(&key2);
let val3 = env.storage().persistent().get(&key3);

// After: Combined or cached
let (val1, val2, val3) = fetch_all_values(&env);
```

### 5. String and Symbol Handling

**Problem**: String literals and symbol creation add overhead.

**Solutions**:
- Use `symbol_short!()` macro for short symbols (max 12 chars)
- Reuse strings as much as possible
- Avoid creating strings in loops
- Use fixed-size byte arrays instead of dynamic strings where possible

### 6. Error Handling Efficiency

**Problem**: Verbose error handling increases code size.

**Solutions**:
- Use concise error enum variants
- Combine related errors instead of having many distinct error types
- Avoid embedding large error messages
- Use Result<T, E> efficiently with `?` operator

### 7. External Library Usage

**Problem**: Pulling in heavy dependencies increases size.

**Solutions**:
- Minimize Soroban SDK feature usage
- Avoid importing unused modules
- Inline simple utility functions instead of using libraries
- Consider writing minimal replacements for heavy functions

### 8. Code Generation and Macros

**Problem**: Unoptimized macro expansion can duplicate code.

**Solutions**:
- Use `#[inline]` and `#[inline(never)]` judiciously
- Reduce macro complexity or consolidate macros
- Review generated code size from procedural macros

### 9. Type System Optimization

**Problem**: Generic types generate monomorphization bloat.

**Solutions**:
- Use dynamic dispatch (trait objects) for types used in multiple ways
- Consolidate generic bounds
- Avoid over-specialization
- Use `#[inline(never)]` on large generic implementations

### 10. Testing and Conditional Compilation

**Problem**: Test code included in release builds.

**Solutions**:
- Ensure tests use `#[cfg(test)]`
- Build with `--release` flag
- Use `#[no_std]` attribute to eliminate standard library
- Verify `crate-type = ["cdylib"]` in Cargo.toml

## Monitoring and CI

### Per-Function Analysis

The `scripts/analyze-contract-sizes.sh` script analyzes WASM binaries and reports:
- Total contract size
- Estimated function count
- Average function size
- Violations against per-function budgets

Run locally:
```bash
./scripts/analyze-contract-sizes.sh ./target/wasm32-unknown-unknown/release
```

### CI Integration

The CI pipeline automatically:
1. Builds all contracts with optimizations
2. Analyzes per-function sizes
3. Generates a size analysis report
4. Uploads reports as CI artifacts
5. Warns on size budget violations

### Size Regression Detection

Monitor changes across PRs by comparing:
- Absolute binary sizes
- Per-function average sizes
- Number of functions

## Tools

### Required
- Rust with `wasm32-unknown-unknown` target
- `cargo`

### Optional (for advanced analysis)
- `wabt` (Web Assembly Binary Toolkit) - provides `wasm-dis` for disassembly
- `wasm-opt` (from Binaryen) - for size optimization

Install `wabt`:
```bash
# macOS
brew install wabt

# Ubuntu/Debian
sudo apt-get install wabt

# Or from source
git clone https://github.com/WebAssembly/wabt.git
cd wabt && mkdir build && cd build && cmake .. && cmake --build .
```

## Common Issues

### Issue: Function exceeds budget

**Diagnosis**:
1. Identify the largest functions using `wasm-dis`
2. Check for duplicated code across functions
3. Look for heavy dependencies

**Solutions**:
- Refactor into smaller helper functions
- Extract common logic
- Consider splitting into sub-contracts

### Issue: Consistent size growth

**Diagnosis**:
1. Run `cargo bloat --release` to find largest items
2. Check recent commits for new dependencies
3. Review added features or error handling

**Solutions**:
- Remove unused dependencies
- Defer non-essential features
- Optimize error types and validation

### Issue: Unexpected optimization regression

**Diagnosis**:
1. Compare Rust versions
2. Check `Cargo.lock` for dependency changes
3. Verify `opt-level` in `Cargo.toml`

**Solutions**:
```toml
[profile.release]
opt-level = "z"        # Optimize for size
lto = true             # Enable link-time optimization
codegen-units = 1      # Improve optimization at cost of compile time
strip = true           # Strip symbols
```

## Future Improvements

1. **More granular per-function tracking**: Parse WASM binary format directly
2. **Historical size trending**: Track size metrics over time
3. **Automated suggestions**: Generate optimization recommendations
4. **Integration with wasm-opt**: Automatically apply size optimizations
5. **Function-level budgets**: Set individual budgets for critical functions
