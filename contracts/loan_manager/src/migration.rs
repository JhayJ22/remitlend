//! Storage migration helper (#793): lazy, backward-compatible reads of
//! versioned structs plus a read-only storage-schema version.
//!
//! Pattern: when a stored struct gains a field, keep the previous layout as
//! `<Name>V{N}` and add `migrate_v{N}_to_v{N+1}`. Readers go through
//! `MigrationHelper::load_loan`, which tries the current layout first and
//! falls back to the legacy layout, rewriting the entry in the new layout on
//! first read, so old entries never cause deserialization panics.
use soroban_sdk::{contracttype, symbol_short, Address, Env, TryFromVal, Val};

use crate::{DataKey, Loan, LoanStatus};

/// Current storage schema version (v2 = `Loan` gained `extension_count` and `term_ledgers`).
pub const STORAGE_SCHEMA_VERSION: u32 = 2;
/// Schema version assumed for contracts that never recorded one.
pub const LEGACY_SCHEMA_VERSION: u32 = 1;
/// Term assigned to legacy loans that predate `term_ledgers`.
pub const LEGACY_DEFAULT_TERM_LEDGERS: u32 = 17280;

#[contracttype]
#[derive(Clone)]
pub enum MigrationKey {
    StorageVersion,
}

/// `Loan` layout at schema v1 (before `extension_count` / `term_ledgers`).
#[contracttype]
#[derive(Clone)]
pub struct LoanV1 {
    pub borrower: Address,
    pub amount: i128,
    pub collateral_amount: i128,
    pub principal_paid: i128,
    pub interest_paid: i128,
    pub accrued_interest: i128,
    pub late_fee_paid: i128,
    pub accrued_late_fee: i128,
    pub interest_rate_bps: u32,
    pub due_date: u32,
    pub last_interest_ledger: u32,
    pub last_late_fee_ledger: u32,
    pub status: LoanStatus,
    pub interest_residual: i128,
}

pub trait MigrationHelper {
    fn storage_version(env: &Env) -> u32;
    fn set_storage_version(env: &Env, version: u32);
    fn migrate_v1_to_v2(legacy: LoanV1) -> Loan;
    fn load_loan(env: &Env, loan_id: u32) -> Option<Loan>;
}

pub struct LoanMigrations;

impl MigrationHelper for LoanMigrations {
    fn storage_version(env: &Env) -> u32 {
        env.storage()
            .instance()
            .get(&MigrationKey::StorageVersion)
            .unwrap_or(LEGACY_SCHEMA_VERSION)
    }

    fn set_storage_version(env: &Env, version: u32) {
        env.storage()
            .instance()
            .set(&MigrationKey::StorageVersion, &version);
    }

    fn migrate_v1_to_v2(legacy: LoanV1) -> Loan {
        Loan {
            borrower: legacy.borrower,
            amount: legacy.amount,
            collateral_amount: legacy.collateral_amount,
            principal_paid: legacy.principal_paid,
            interest_paid: legacy.interest_paid,
            accrued_interest: legacy.accrued_interest,
            late_fee_paid: legacy.late_fee_paid,
            accrued_late_fee: legacy.accrued_late_fee,
            interest_rate_bps: legacy.interest_rate_bps,
            due_date: legacy.due_date,
            last_interest_ledger: legacy.last_interest_ledger,
            last_late_fee_ledger: legacy.last_late_fee_ledger,
            status: legacy.status,
            interest_residual: legacy.interest_residual,
            extension_count: 0,
            term_ledgers: LEGACY_DEFAULT_TERM_LEDGERS,
        }
    }

    /// Read a loan in whichever layout it was stored; migrate lazily on first read.
    fn load_loan(env: &Env, loan_id: u32) -> Option<Loan> {
        let key = DataKey::Loan(loan_id);
        let raw: Val = env.storage().persistent().get(&key)?;
        if let Ok(loan) = Loan::try_from_val(env, &raw) {
            return Some(loan);
        }
        let legacy = LoanV1::try_from_val(env, &raw).expect("unrecognised loan schema");
        let migrated = Self::migrate_v1_to_v2(legacy);
        env.storage().persistent().set(&key, &migrated);
        env.events()
            .publish((symbol_short!("MIGRATED"), loan_id), STORAGE_SCHEMA_VERSION);
        Some(migrated)
    }
}

/// Called from the upgrade transaction: records the schema version the upgraded
/// code expects. Entries themselves are migrated lazily on first read.
pub fn on_upgrade(env: &Env) {
    LoanMigrations::set_storage_version(env, STORAGE_SCHEMA_VERSION);
}
