# LoanManager Upgrade Process

This document describes the upgrade governance process for the LoanManager contract using the proxy pattern with timelock.

## Overview

The upgrade proxy implements a 48-hour timelock mechanism to ensure upgrade security. All contract upgrades must:

1. Be scheduled by the admin
2. Wait 48 hours (approximately 34,560 ledgers on Stellar)
3. Be executed by admin after timelock expires
4. Optionally include migration data for schema changes

## Key Components

### UpgradeProxy Module

Located in `contracts/loan_manager/src/upgrade_proxy.rs`, the proxy provides:

- **schedule_upgrade()**: Schedule a new WASM deployment with optional migration data
- **execute_upgrade()**: Execute scheduled upgrade after timelock
- **cancel_upgrade()**: Cancel pending upgrade before execution
- **get_scheduled_upgrade()**: Query pending upgrade info
- **get_upgrade_delay()**: Get current timelock delay
- **set_upgrade_delay()**: Modify delay for future upgrades (admin only)
- **propose_new_admin()** / **accept_admin()**: Two-step admin transfer

### Events

The proxy emits the following events:

- `UpgradeScheduled`: When a new upgrade is scheduled
  - Event: `(UPGRADE, SCHED, scheduled_at, wasm_hash)`
  
- `UpgradeExecuted`: When an upgrade is executed
  - Event: `(UPGRADE, EXEC, wasm_hash, execution_ledger)`
  
- `UpgradeCancelled`: When an upgrade is cancelled
  - Event: `(UPGRADE, CANCEL)`

## Usage Example

### Schedule an Upgrade

```rust
let wasm_hash = BytesN::from_array(&env, &[0x01, 0x02, ...]);
let scheduled_at = upgrade_proxy::UpgradeProxy::schedule_upgrade(
    &env,
    &wasm_hash,
    None, // Optional migration data
);
println!("Upgrade scheduled for ledger {}", scheduled_at);
```

### Execute an Upgrade (after 48 hours)

```rust
let old_wasm = upgrade_proxy::UpgradeProxy::execute_upgrade(&env);
println!("Upgrade executed. Previous WASM: {:?}", old_wasm);
```

### Data Migration Between Versions

If your upgrade requires data migration:

```rust
let migration_data = some_migration_function();
upgrade_proxy::UpgradeProxy::schedule_upgrade(
    &env,
    &new_wasm_hash,
    Some(migration_data),
);
```

## Security Properties

### Timelock Guarantee

The 48-hour timelock provides:

- **Community Review**: Stakeholders have time to review and discuss upgrade
- **Emergency Pause**: Time to prepare rollback if needed
- **Transparency**: All scheduled upgrades are queryable

### Admin Protection

- Two-step admin transfer prevents accidental loss of upgrade control
- Current admin must explicitly propose new admin
- Proposed admin must explicitly accept role

### Immutable History

- Previous WASM hashes are retained for rollback capability
- All upgrades emit events for auditing
- Ledger-based timing is cryptographically secured by Stellar

## Fallback and Rollback

While the proxy pattern allows querying previous WASM hashes, actual rollback requires:

1. Scheduling a new upgrade back to the previous version
2. Waiting another 48 hours
3. Executing the rollback

For emergency situations, consider maintaining a separate hot-swap contract or emergency pause mechanism.

## Testing

Run formal verification of upgrade mechanics:

```bash
cd contracts/loan_manager
cargo test --lib upgrade_proxy
```

## Invariants

The upgrade system maintains these invariants:

1. **No Immediate Upgrades**: Cannot execute upgrade before timelock expires
2. **Single Scheduled Upgrade**: Only one upgrade can be scheduled at a time
3. **Admin-Only Control**: Only current admin can schedule/execute/cancel upgrades
4. **Sequential Admin Transfer**: Admin transfer requires both proposal and acceptance
5. **Monotonic Versioning**: Current WASM hash is always tracked

## Integration with LoanManager

To integrate the upgrade proxy with LoanManager:

1. Initialize proxy during LoanManager setup
2. Use proxy's `schedule_upgrade()` in admin interface
3. Call proxy's `execute_upgrade()` from governance contract
4. Emit proxy events alongside LoanManager events

```rust
impl LoanManager {
    pub fn initialize_with_upgrade_proxy(
        env: Env,
        nft: Address,
        pool: Address,
        token: Address,
        admin: Address,
    ) {
        // Initialize LoanManager
        Self::initialize(&env, &nft, &pool, &token, &admin);
        
        // Initialize upgrade proxy
        upgrade_proxy::UpgradeProxy::initialize(&env, &admin);
    }
}
```

## Future Enhancements

Potential improvements to the upgrade mechanism:

1. **Multi-sig Governance**: Require multiple admins to approve upgrades
2. **Staged Rollouts**: Deploy to subset of users first
3. **Automatic Rollback**: Revert if critical invariants fail post-upgrade
4. **Upgrade Notifications**: Broadcast upgrade notices to integrated systems
