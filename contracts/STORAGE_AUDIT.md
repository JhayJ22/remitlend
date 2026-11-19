# Storage Audit

> **Audit date:** 2026-04-18
> **Pinned commit:** [`079dccf`](https://github.com/LabsCrypt/remitlend/commit/079dccf6b09f7a87ad61c790d923220d3da44317)
> **Signed off by:** contracts maintainers (issue #818)
>
> This document may drift as storage keys are added or removed.
> Re-validate whenever contract storage changes land and update the date and
> commit reference above. CI (`.github/workflows/storage-audit.yml`) fails the
> build if a `env.storage().persistent().set(...)` call is not listed here.

## Summary

This audit reviewed all current Soroban storage usage across the five main contracts:

- `contracts/lending_pool`
- `contracts/loan_manager`
- `contracts/multisig_governance`
- `contracts/remittance_nft`
- `contracts/yield_distributor`

The protocol stores long-lived state (balances, loan records, counters, config,
admin/minter access, remittance metadata, credit history, yield distribution
state) in `persistent` or `instance` storage because it directly affects
balances, permissions, or repayment state.

## Soroban rent budget reference

Soroban charges rent per ledger entry based on `(entry size in bytes) × (TTL in
ledgers)`. The network enforces a per-entry size cap of **65,536 bytes** and a
per-transaction write budget; the practical guidance used here is to keep each
contract's total persistent footprint well under **~1 MB** and to renew TTLs
before expiry. Estimates below use conservative upper bounds (fixed-width
`i128`/`u32`/`Address` = 32 bytes, `Symbol`/`Bytes` = length + 4).

## Storage keys by contract

### `contracts/lending_pool`

| Key | Type | Max bytes (est.) | TTL policy | Written by |
| --- | --- | --- | --- | --- |
| `DataKey::Admin` | `Address` | 32 | Instance | `initialize`, `set_admin` |
| `DataKey::Token` | `Address` | 32 | Instance | `initialize` |
| `DataKey::Lender(Address)` | `i128` | 32 + 32 | Persistent | `deposit`, `withdraw` |
| `DataKey::TotalDeposits` | `i128` | 16 | Instance | `deposit`, `withdraw` |
| `DataKey::LoanCounter` | `u32` | 4 | Instance | `request_loan` |
| `DataKey::Loan(u32)` | `LoanRecord` | ~256 | Persistent | `request_loan`, `repay` |
| `DataKey::YieldDistributorsSet` | `Vec<Address>` | 32 × N | Persistent | `register_yield_distributor`, `remove_yield_distributor` |
| `DataKey::DistributorCumulativeYield(Address)` | `i128` | 32 + 16 | Persistent | `accrue_yield` |

**Estimated total persistent footprint:** `Lender` map + `Loan` map + yield
keys. With 10k lenders and 10k loans this is ~0.6 MB — within budget, but see
flags below.

### `contracts/loan_manager`

| Key | Type | Max bytes (est.) | TTL policy | Written by |
| --- | --- | --- | --- | --- |
| `DataKey::Admin` | `Address` | 32 | Instance | `initialize` |
| `DataKey::Pool` | `Address` | 32 | Instance | `initialize` |
| `DataKey::Loan(u32)` | `LoanRecord` | ~256 | Persistent | `create_loan`, `repay_loan`, `liquidate` |
| `DataKey::BorrowerLoans(Address)` | `Vec<u32>` | 32 × N | Persistent | `create_loan` |
| `DataKey::PendingRiskChange` | `RiskChange` | ~128 | Persistent | `propose_risk_change`, `apply_risk_change`, `cancel_risk_change` |

**Estimated total persistent footprint:** ~0.4 MB at 10k loans/borrowers —
within budget.

### `contracts/multisig_governance`

| Key | Type | Max bytes (est.) | TTL policy | Written by |
| --- | --- | --- | --- | --- |
| `DataKey::Signers` | `Vec<Address>` | 32 × N | Instance | `initialize`, `update_signers` |
| `DataKey::Threshold` | `u32` | 4 | Instance | `initialize`, `update_signers` |
| `DataKey::Proposal(u32)` | `Proposal` | ~192 | Persistent | `propose`, `approve`, `execute` |
| `DataKey::ProposalCounter` | `u32` | 4 | Instance | `propose` |

**Estimated total persistent footprint:** ~0.2 MB at 1k proposals — within
budget.

### `contracts/remittance_nft`

| Key | Type | Max bytes (est.) | TTL policy | Written by |
| --- | --- | --- | --- | --- |
| `DataKey::Admin` | `Address` | 32 | Instance | `initialize` |
| `DataKey::AuthorizedMinter(Address)` | `bool` | 32 + 1 | Persistent | `add_minter`, `remove_minter` |
| `DataKey::TokenCounter` | `u32` | 4 | Instance | `mint` |
| `DataKey::Owner(u32)` | `Address` | 32 + 4 | Persistent | `mint`, `transfer` |
| `DataKey::Metadata(u32)` | `RemittanceMetadata` | ~320 | Persistent | `mint` |
| `DataKey::CreditHistory(Address)` | `Vec<CreditEvent>` | 32 × N | Persistent | `record_credit_event` |

**Estimated total persistent footprint:** ~0.5 MB at 10k tokens — within
budget, but see flags below.

### `contracts/yield_distributor`

| Key | Type | Max bytes (est.) | TTL policy | Written by |
| --- | --- | --- | --- | --- |
| `DataKey::Admin` | `Address` | 32 | Instance | `initialize` |
| `DataKey::Pool` | `Address` | 32 | Instance | `initialize` |
| `DataKey::DistributorCumulativeYield(Address)` | `i128` | 32 + 16 | Persistent | `distribute` |
| `DataKey::PendingRiskChange` | `RiskChange` | ~128 | Persistent | `propose_risk_change`, `apply_risk_change` |

**Estimated total persistent footprint:** ~0.1 MB at 1k distributors — within
budget.

## Temporary Storage Review

Temporary storage is appropriate for short-lived, regenerable data such as:

- one-time session markers
- cached quote calculations
- expiring workflow checkpoints
- rate-limiting counters

No existing contract key currently satisfies those conditions without
introducing the risk of unexpected expiry changing protocol behavior. For that
reason, no business-critical key is stored in `temporary` storage today.

## Renewal Logic

Renewal helpers extend TTL for:

- contract instance configuration
- persistent lender balances
- persistent loan records
- persistent remittance metadata and authorized minter state
- persistent yield distributor cumulative yield

This keeps long-lived protocol state renewable while preserving the correct
storage class for each key.

## Flagged keys (unbounded growth)

The following `Persistent` keys grow with the number of users/records and must
be capped or archived before mainnet scale:

- `lending_pool::DataKey::Lender(Address)` — per-lender map; cap active lenders
  or archive zero balances.
- `lending_pool::DataKey::Loan(u32)` — per-loan map; archive settled loans.
- `lending_pool::DataKey::YieldDistributorsSet` — `Vec<Address>` grows per
  distributor; cap set size or move to a paginated registry.
- `lending_pool::DataKey::DistributorCumulativeYield(Address)` — per-distributor
  map; archive inactive distributors.
- `loan_manager::DataKey::BorrowerLoans(Address)` — per-borrower `Vec<u32>`;
  cap history length or prune closed loans.
- `loan_manager::DataKey::Loan(u32)` — per-loan map; archive settled loans.
- `remittance_nft::DataKey::Owner(u32)` / `Metadata(u32)` — per-token map;
  archival strategy required as token count grows.
- `remittance_nft::DataKey::CreditHistory(Address)` — per-user `Vec`; cap
  event count or roll up older events.

## CI verification

`.github/workflows/storage-audit.yml` greps every Rust source file for
`env.storage().persistent().set(` and asserts the corresponding key name
appears in this document. New persistent keys must be added here in the same
PR that introduces them.
