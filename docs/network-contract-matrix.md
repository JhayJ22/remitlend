# Supported Network and Contract Version Matrix

This document is the authoritative reference for which contract versions are
deployed on which Stellar networks, what SDK and toolchain versions they were
compiled with, and what the minimum client requirements are for each network.

For raw contract IDs, see [`docs/deployed-contracts.md`](./deployed-contracts.md).

---

## Network support overview

| Network | Status | RPC endpoint | Explorer |
|---|---|---|---|
| Testnet | ✅ Active | `https://soroban-testnet.stellar.org` | [stellar.expert/testnet](https://stellar.expert/explorer/testnet) |
| Futurenet | 🔜 Planned | `https://rpc-futurenet.stellar.org` | [stellar.expert/futurenet](https://stellar.expert/explorer/futurenet) |
| Mainnet | 🔜 Planned | `https://mainnet.stellar.validationcloud.io` | [stellar.expert/mainnet](https://stellar.expert/explorer/mainnet) |

> Update this table when a network is added or retired.

---

## Contract version matrix

The table below maps each deployed contract to its semantic version, the
`soroban-sdk` it was compiled against, the Rust toolchain, and the current
status of that deployment.

### Testnet

| Contract | Version | `soroban-sdk` | Rust toolchain | WASM hash prefix | Status |
|---|---|---|---|---|---|
| `loan_manager` | v1.0.0 | 22.0.0 | 1.85.0 (wasm32) | *(record on deploy)* | 🟡 Under development |
| `lending_pool` | v1.0.0 | 22.0.0 | 1.85.0 (wasm32) | *(record on deploy)* | 🟡 Under development |
| `remittance_nft` | v1.0.0 | 22.0.0 | 1.85.0 (wasm32) | *(record on deploy)* | 🟡 Under development |
| `multisig_governance` | v1.0.0 | 22.0.0 | 1.85.0 (wasm32) | *(record on deploy)* | 🟡 Under development |
| `money` (library) | v1.0.0 | 22.0.0 | 1.85.0 (wasm32) | N/A (no-std lib) | 🟡 Under development |

### Futurenet

No contracts deployed yet.

### Mainnet

No contracts deployed yet.

---

## Version compatibility rules

These rules govern which client and backend versions are compatible with each
contract version.

| Contract version | Backend `soroban-client` / `stellar-sdk` | Frontend `@stellar/stellar-sdk` | Notes |
|---|---|---|---|
| v1.x | ≥ 11.0.0 | ≥ 11.0.0 | Initial production series |

When a contract version introduces a breaking interface change, the minimum
client version in this table must be bumped and an ADR must be filed (see
[`docs/adr/README.md`](./adr/README.md)).

---

## Governance parameters per network

These values are enforced on-chain and vary by deployment.

| Parameter | Testnet | Mainnet |
|---|---|---|
| Governance timelock | 24 h (`MIN_TIMELOCK_SECONDS = 86400`) | 24 h |
| Upgrade proxy timelock | 48 h | 48 h |
| Proposal TTL | 7 days | 7 days |
| Max signers | 20 | 20 |
| Reproposal cooldown | 1 h | 1 h |

Changes to these parameters require a governance proposal.  See
[`docs/protocol-parameter-governance.md`](./protocol-parameter-governance.md).

---

## How to read WASM hashes

The WASM hash uniquely identifies the compiled contract logic.  It is stored
on-chain by the upgrade proxy and emitted in `(UPGRADE, EXEC, …)` events.
To verify a deployed WASM hash matches the source:

```bash
# Build with the pinned toolchain
cd contracts
cargo build --target wasm32-unknown-unknown --release

# Compute hash of the built WASM
sha256sum target/wasm32-unknown-unknown/release/<contract_name>.wasm

# Compare with the on-chain hash stored in the upgrade proxy
soroban contract invoke \
  --id <CONTRACT_ID> \
  --rpc-url <RPC_URL> \
  --network-passphrase "<PASSPHRASE>" \
  -- get_scheduled_upgrade
```

The pinned toolchain is in `contracts/rust-toolchain.toml` (channel `1.85.0`).
Using a different toolchain will produce a different WASM byte-for-byte even
for identical source, causing hash mismatch.

---

## Updating this document

1. After every deployment, update the WASM hash prefix column with the first
   8 hex characters of the `sha256` hash.
2. Bump the contract version column when a new contract version is deployed.
3. If a new network is added, add a row to the network support table and a new
   section under "Contract version matrix".
4. Open a PR.  The PR must be reviewed by at least one maintainer.

See also [`docs/deployed-contracts.md`](./deployed-contracts.md) for the full
contract ID registry.

---

## End-of-life and deprecation

When a network or contract version reaches end-of-life:

1. Update the status column to `🔴 Deprecated` at least 30 days before
   decommissioning.
2. Announce the deprecation in `CHANGELOG.md` and via a GitHub issue tagged
   `deprecation`.
3. Remove the row only after the network/version has been fully shut down.

---

## Rollback matrix

If a bad contract version is detected, the rollback target is the previously
active WASM hash.  The upgrade proxy stores previous WASM hashes.  Rollback
steps are described in [`contracts/UPGRADE_PROCESS.md`](../contracts/UPGRADE_PROCESS.md).

| Contract | Current version | Last stable version | Rollback WASM hash |
|---|---|---|---|
| `loan_manager` | v1.0.0 | — | *(none — first deployment)* |
| `lending_pool` | v1.0.0 | — | *(none — first deployment)* |
| `remittance_nft` | v1.0.0 | — | *(none — first deployment)* |
| `multisig_governance` | v1.0.0 | — | *(none — first deployment)* |
