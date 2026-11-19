# LoanManager Contract Migration Strategy

This document outlines the migration strategy for LoanManager contract upgrades.

## Overview

The `migrate()` function is responsible for:
1. Initializing new storage keys with defaults when upgrading to a new contract version
2. Performing any necessary data transformations
3. Preventing double-execution of migrations for the same version

## Current Migrations

### Version 4

The current version includes migrations for:
- `LateFeeRateBps` - Late fee rate configuration
- `LiquidationThresholdBps` - Threshold for loan liquidation
- `LiquidationBonusBps` - Bonus paid to liquidators (with MAX_LIQUIDATION_BONUS_BPS = 2000 cap)
- `RateOracle` - Optional oracle address for dynamic interest rates
- `MinRateBps` / `MaxRateBps` - Bounds on interest rate calculations

## Migration Guard

Each migration is guarded by:
1. **Version Tracking**: The contract stores the last migrated version in `DataKey::MigratedVersion`
2. **Idempotency**: The `migrate()` function checks if we're already at the current version before executing
3. **Single-Execution**: If `MigratedVersion >= CURRENT_VERSION`, the migration is skipped

This prevents:
- Double-execution of migrations
- Data corruption from re-running migrations
- Admin errors from calling `migrate()` multiple times

## Adding New Migrations

When adding a new contract version:

1. Increment `CURRENT_VERSION`
2. Add migration logic in `migrate()` function to initialize new storage keys
3. Use `if !env.storage().instance().has(&DataKey::NewKey)` pattern to safely add new fields
4. Transformation logic can be added within each check
5. The migration guard automatically prevents re-execution

## Schema Evolution

### Data Structure Changes

If a field in an existing struct needs to be renamed or its type changed:
1. Create a new DataKey for the new structure
2. In `migrate()`, read from old DataKey, transform, and write to new DataKey
3. Optionally keep the old key for backward compatibility
4. Document the change in migration notes

### Storage Key Renames

If a DataKey needs to be renamed:
1. Create migration logic to copy data from old key to new key
2. Update all references to use the new key
3. Old key data can be cleaned up in a subsequent migration (optional)

## Testing Migrations

When testing a migration:
1. Create a test that deploys the old contract version
2. Initialize data using the old schema
3. Deploy the new contract version
4. Call `migrate()`
5. Verify all data is readable using the new contract's getters
6. Verify the migration cannot be called twice

Example test pattern:
```rust
#[test]
fn test_migration_from_v3_to_v4() {
    // Deploy old version, create data
    // Upgrade to new version
    // Call migrate()
    // Verify data integrity
}
```

## Emergency Rollback

If a migration fails or needs to be rolled back:
1. Redeploy the previous contract version (requires new contract ID)
2. Manually recover data from on-chain storage if needed
3. Test migration thoroughly on testnet before re-attempting on mainnet

## Version History

- **v4**: Initial structured migration with guard mechanism
  - Added rate bounds (MIN_RATE_BPS, MAX_RATE_BPS)
  - Added liquidation bonus cap (MAX_LIQUIDATION_BONUS_BPS = 2000)
  - Migration guard prevents double-execution

## Release Bundle and Compatibility Implications

Every contract release is published as an immutable release bundle. The bundle is the
authoritative record of what was deployed and is the only accepted evidence for a
migration claim.

### Bundle contents

A release bundle contains, at minimum:

- **Source revision** - the exact commit SHA the WASM was built from.
- **Lockfile digests** - SHA-256 of `Cargo.lock` (and any other pinned dependency
  manifests) used for the build.
- **Test results** - machine-readable output of the contract test suite, including
  migration tests and mutation-testing results.
- **Generated API schemas** - the exported contract spec / ABI for the released
  version, so clients can diff against the previous release.
- **WASM hashes** - SHA-256 of each produced `.wasm` artifact.
- **Deployment manifest** - network, contract ID, `CURRENT_VERSION`, and the
  `MigratedVersion` expected after `migrate()` runs.

Every artifact in the bundle must trace back to the single immutable build identified
by the source revision and lockfile digests. Artifacts that cannot be traced to that
build are rejected and must not be deployed.

### Schema change compatibility

Public or stored schema changes (new `DataKey`s, struct field changes, storage key
renames) are compatibility-relevant and must be documented in this file and in the
bundle's generated API schema diff. The rules are:

1. **Additive changes** (new `DataKey` initialized in `migrate()` with a default) are
   backward compatible. The previous release's getters must continue to return valid
   values after `migrate()`.
2. **Transformative changes** (renamed keys, changed types) require a documented
   migration path and a test proving old data is readable through the new getters.
3. **Removals** are only permitted after a release in which the old key is no longer
   read; the removal is recorded in the bundle's schema diff.
4. `CURRENT_VERSION` must be incremented for any stored schema change, and the
   deployment manifest must record the expected post-migration `MigratedVersion`.

### Hermetic migration matrix

Migrations are validated in a hermetic matrix before release:

- Supported PostgreSQL versions are exercised from an empty database and from
  prior-schema fixtures.
- Migrations and seeds are applied, then rollback and retry behavior is verified.
- The matrix runs without production data and without external network access.

The matrix results are attached to the release bundle as test evidence. A release
whose migration matrix has not passed is not eligible for deployment.

### Mutation testing

Mutation testing runs against the contract sources identified by the bundle's source
revision. Surviving mutants in migration, guard, or money-handling code are treated as
unresolved risk evidence and block release until addressed or explicitly waived with a
recorded justification in the traceability workflow.

### Traceability workflow

Accepted requirements are linked to implementation PRs, required risk evidence,
release notes, and deployment checks. Each link references the immutable build
(source revision + lockfile digests) so that every artifact is traceable to one build.
Release is blocked when high-risk acceptance criteria are unresolved or silently
waived; waivers must be explicit, recorded, and visible in the bundle.

### Rollback and retry

Rollback and retry are validated as part of the hermetic migration matrix. The
migration guard (`DataKey::MigratedVersion`) ensures retries are idempotent: a
re-run of `migrate()` at the same version is a no-op and must not produce partial
state changes. If a migration fails mid-way, the previous contract version is
redeployed per the Emergency Rollback section above and the failure is recorded in
the release bundle.
