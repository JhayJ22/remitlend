//! Storage migration helper (#793). See loan_manager/MIGRATION.md for the pattern.
//!
//! Lazy migration: legacy `Score(user)` entries are rewritten as
//! `Metadata(user)` on first read (see `RemittanceNFT::get_or_migrate_metadata`).
use soroban_sdk::{Address, Env};

use crate::{DataKey, RemittanceMetadata, RemittanceNFT};

/// Schema v2 = score stored inside `RemittanceMetadata` (v1 = bare `Score(user)`).
pub const STORAGE_SCHEMA_VERSION: u32 = 2;
pub const LEGACY_SCHEMA_VERSION: u32 = 1;

pub trait MigrationHelper {
    fn storage_version(env: &Env) -> u32;
    fn set_storage_version(env: &Env, version: u32);
    /// Migrate one user's v1 `Score` entry to v2 `Metadata` (no-op if already v2).
    fn migrate_v1_to_v2(env: &Env, user: &Address) -> Option<RemittanceMetadata>;
}

pub struct NftMigrations;

impl MigrationHelper for NftMigrations {
    fn storage_version(env: &Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::StorageVersion)
            .unwrap_or(LEGACY_SCHEMA_VERSION)
    }

    fn set_storage_version(env: &Env, version: u32) {
        env.storage()
            .instance()
            .set(&DataKey::StorageVersion, &version);
    }

    fn migrate_v1_to_v2(env: &Env, user: &Address) -> Option<RemittanceMetadata> {
        RemittanceNFT::get_or_migrate_metadata(env, user)
    }
}
