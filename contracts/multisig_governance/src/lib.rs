#![no_std]

#[cfg(test)]
mod test;
mod emergency_pause;

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, BytesN, Env,
    IntoVal, Map, Symbol, Vec,
};
use emergency_pause::{PauseStatus, PendingPause};

// ─── Constants ────────────────────────────────────────────────────────────────

/// Minimum timelock: 24 hours. Cannot be overridden by the proposing admin.
const MIN_TIMELOCK_SECONDS: u64 = 86_400;

/// Maximum signers in a quorum — keeps storage and iteration bounded.
const MAX_SIGNERS: u32 = 20;

/// Time-to-live for proposals before they expire (7 days in seconds).
const PROPOSAL_TTL_SECONDS: u64 = 604_800;

// ─── Storage keys ─────────────────────────────────────────────────────────────

const KEY_ADMIN: Symbol = symbol_short!("ADMIN");
const KEY_VERSION: Symbol = symbol_short!("VERSION");
const KEY_PENDING: Symbol = symbol_short!("PENDING");
const KEY_TARGET: Symbol = symbol_short!("TARGET");
const KEY_LAST_CANCELLED_AT: Symbol = symbol_short!("CANCEL_AT");
const KEY_PROPOSAL_COUNT: Symbol = symbol_short!("COUNT");

const REPROPOSAL_COOLDOWN_SECONDS: u64 = 3600; // 1 hour
const CURRENT_VERSION: u32 = 1;

// ─── Types ────────────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum GovernanceError {
    AlreadyInitialized = 4001,
    NotInitialized = 4002,
    TargetNotSet = 4003,
    NoPendingTransfer = 4004,
    TransferAlreadyPending = 4005,
    ThresholdExceedsSignerCount = 4006,
    ThresholdTooLow = 4007,
    TooManySigners = 4008,
    SignerNotAllowed = 4009,
    TimelockNotElapsed = 4010,
    ThresholdNotMet = 4011,
    DelayTooShort = 4012,
    EmptySignerList = 4013,
    ReproposalCooldownActive = 4015,
    ProposalExpired = 4016,
    ProposalNotExpired = 4017,
    ProposalIdMismatch = 4018,
    ProposalNotActive = 4019,
    DuplicateSigner = 4020,
}

/// Status of a pending admin transfer proposal.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProposalStatus {
    Active = 0,
    Cancelled = 1,
}

/// A pending admin transfer proposal.
#[contracttype]
#[derive(Clone, Debug)]
pub struct PendingTransfer {
    /// Unique identifier for the proposal.
    pub id: u32,
    /// Address that will become admin once finalized (may be a Gnosis Safe or DAO).
    pub proposed_admin: Address,
    /// Ordered list of addresses forming the multi-sig quorum.
    pub signers: Vec<Address>,
    /// Minimum approvals required before finalization is unblocked.
    pub threshold: u32,
    /// Ledger timestamp after which finalize_admin_transfer may be called.
    pub executable_after: u64,
    /// Map signer -> true for each signer that has approved.
    pub approvals: Map<Address, bool>,
    /// Timestamp when the proposal was created.
    pub proposed_at: u64,
    /// Lifecycle status of the proposal.
    pub status: ProposalStatus,
}

/// Emitted when a transfer is proposed.
#[contracttype]
#[derive(Clone, Debug)]
pub struct AdminTransferProposedEvent {
    pub proposed_admin: Address,
    pub signers: Vec<Address>,
    pub threshold: u32,
    pub executable_after: u64,
    pub proposed_by: Address,
    pub timestamp: u64,
}

/// Emitted when a transfer is finalized.
#[contracttype]
#[derive(Clone, Debug)]
pub struct AdminTransferFinalizedEvent {
    pub new_admin: Address,
    pub finalized_by: Address,
    pub approval_count: u32,
    pub timestamp: u64,
}

/// Emitted when a pending transfer is cancelled.
#[contracttype]
#[derive(Clone, Debug)]
pub struct AdminTransferCancelledEvent {
    pub cancelled_by: Address,
    pub timestamp: u64,
}

/// Emitted when a proposal is emergency cancelled.
#[contracttype]
#[derive(Clone, Debug)]
pub struct ProposalCancelledEvent {
    pub cancelled_by: Address,
    pub proposal_id: u32,
    pub reason: Option<soroban_sdk::String>,
    pub timestamp: u64,
}

/// Emitted each time a signer approves.
#[contracttype]
#[derive(Clone, Debug)]
pub struct ProposalApprovedEvent {
    pub proposal_id: u32,
    pub signer: Address,
    pub approvals_so_far: u32,
    pub threshold: u32,
    pub timestamp: u64,
}

/// Emitted when a proposal expires due to TTL.
#[contracttype]
#[derive(Clone, Debug)]
pub struct ProposalExpiredEvent {
    pub expired_by: Address,
    pub proposal_timestamp: u64,
    pub expiry_timestamp: u64,
}

/// Per-operation pause flags. Mirrors the lending pool's `PauseFlags` so the
/// governance payload can be consumed directly by the pool and loan manager.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PauseFlags {
    pub deposits: bool,
    pub withdrawals: bool,
    pub yield_claims: bool,
    pub loan_approvals: bool,
    pub repayments: bool,
}

impl PauseFlags {
    pub fn none() -> Self {
        Self {
            deposits: false,
            withdrawals: false,
            yield_claims: false,
            loan_approvals: false,
            repayments: false,
        }
    }

    pub fn all() -> Self {
        Self {
            deposits: true,
            withdrawals: true,
            yield_claims: true,
            loan_approvals: true,
            repayments: true,
        }
    }
}

/// Structured payload emitted by governance and consumed by the pool and loan
/// manager to set their respective `PauseFlags`.
#[contracttype]
#[derive(Clone, Debug)]
pub struct EmergencyPausePayload {
    /// Address that activated the pause.
    pub actor: Address,
    /// Per-operation flags to apply.
    pub flags: PauseFlags,
    /// Ledger timestamp at activation.
    pub timestamp: u64,
    /// Optional human-readable reason.
    pub reason: Option<soroban_sdk::String>,
    /// If Some(n), the pause auto-expires after n ledgers.
    pub max_duration_ledgers: Option<u32>,
    /// Ledger sequence at which the pause auto-expires (0 = no expiry).
    pub expires_at_ledger: u32,
}

/// Emitted when an emergency pause is activated.
#[contracttype]
#[derive(Clone, Debug)]
pub struct EmergencyPauseActivatedEvent {
    pub actor: Address,
    pub flags: PauseFlags,
    pub timestamp: u64,
    pub reason: Option<soroban_sdk::String>,
    pub max_duration_ledgers: Option<u32>,
    pub expires_at_ledger: u32,
}

/// Emitted when an emergency pause is lifted.
#[contracttype]
#[derive(Clone, Debug)]
pub struct EmergencyPauseLiftedEvent {
    pub actor: Address,
    pub timestamp: u64,
}

// ─── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct GovernanceContract;

#[contractimpl]
impl GovernanceContract {
    // ── Initialization ────────────────────────────────────────────────────────

    /// Initialize the governance contract.
    /// `admin`           — current RemitLend admin.
    /// `target_contract` — the RemitLend contract whose admin will be updated
    ///                     when finalize_admin_transfer is called.
    pub fn initialize(
        env: Env,
        admin: Address,
        target_contract: Address,
    ) -> Result<(), GovernanceError> {
        if env.storage().instance().has(&KEY_ADMIN) {
            return Err(GovernanceError::AlreadyInitialized);
        }
        env.storage().instance().set(&KEY_ADMIN, &admin);
        env.storage().instance().set(&KEY_TARGET, &target_contract);
        env.storage().instance().set(&KEY_VERSION, &CURRENT_VERSION);
        env.storage().instance().set(&KEY_PROPOSAL_COUNT, &0u32);
        Ok(())
    }

    pub fn version(env: Env) -> u32 {
        env.storage().instance().get(&KEY_VERSION).unwrap_or(0)
    }

    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), GovernanceError> {
        let admin = Self::read_admin(&env)?;
        admin.require_auth();

        let old_version = Self::version(env.clone());
        let new_version = old_version.saturating_add(1);
        env.storage().instance().set(&KEY_VERSION, &new_version);
        env.events().publish(
            (Symbol::new(&env, "ContractUpgraded"),),
            (old_version, new_version),
        );

        env.deployer().update_current_contract_wasm(new_wasm_hash);
        Ok(())
    }

    // ── Emergency pause ───────────────────────────────────────────────────────

    /// Activate an emergency pause with per-operation granularity.
    ///
    /// Only the admin may call this. The structured payload is emitted as an
    /// event so the pool and loan manager can consume it and set their own
    /// `PauseFlags`. If `max_duration_ledgers` is Some(n), the pause
    /// auto-expires after n ledgers.
    pub fn emergency_pause(
        env: Env,
        flags: PauseFlags,
        reason: Option<soroban_sdk::String>,
        max_duration_ledgers: Option<u32>,
    ) -> Result<(), GovernanceError> {
        let admin = Self::read_admin(&env)?;
        admin.require_auth();

        let now = env.ledger().timestamp();
        let current_ledger = env.ledger().sequence();
        let expires_at_ledger = match max_duration_ledgers {
            Some(d) => current_ledger.saturating_add(d),
            None => 0,
        };

        let payload = EmergencyPausePayload {
            actor: admin.clone(),
            flags: flags.clone(),
            timestamp: now,
            reason: reason.clone(),
            max_duration_ledgers,
            expires_at_ledger,
        };

        env.storage()
            .instance()
            .set(&symbol_short!("PAUSE"), &payload);

        env.events().publish(
            (Symbol::new(&env, "EmergencyPauseActivated"),),
            EmergencyPauseActivatedEvent {
                actor: admin,
                flags,
                timestamp: now,
                reason,
                max_duration_ledgers,
                expires_at_ledger,
            },
        );
        Ok(())
    }

    /// Lift an active emergency pause.
    pub fn emergency_unpause(env: Env) -> Result<(), GovernanceError> {
        let admin = Self::read_admin(&env)?;
        admin.require_auth();

        env.storage()
            .instance()
            .remove(&symbol_short!("PAUSE"));

        env.events().publish(
            (Symbol::new(&env, "EmergencyPauseLifted"),),
            EmergencyPauseLiftedEvent {
                actor: admin,
                timestamp: env.ledger().timestamp(),
            },
        );
        Ok(())
    }

    /// Return the currently active pause payload, accounting for time-bounded
    /// auto-expiry. Returns `None` if no pause is active or it has expired.
    pub fn get_active_pause(env: Env) -> Option<EmergencyPausePayload> {
        let payload: Option<EmergencyPausePayload> = env
            .storage()
            .instance()
            .get(&symbol_short!("PAUSE"));
        match payload {
            Some(p) => {
                if p.expires_at_ledger != 0
                    && env.ledger().sequence() >= p.expires_at_ledger
                {
                    None
                } else {
                    Some(p)
                }
            }
            None => None,
        }
    }

    // ── Propose ───────────────────────────────────────────────────────────────

    /// Propose a transfer of the admin role.
    ///
    /// Only the current admin may call this. Any pending proposal must be
    /// cancelled before a new one can be submitted.
    ///
    /// `delay_seconds` must be >= MIN_TIMELOCK_SECONDS (86400 = 24 h).
    /// `threshold` must be in [1, len(signers)] and len(signers) <= MAX_SIGNERS.
    pub fn propose_admin_transfer(
        env: Env,
        proposed_admin: Address,
        signers: Vec<Address>,
        threshold: u32,
        delay_seconds: u64,
    ) -> Result<(), GovernanceError> {
        let admin = Self::read_admin(&env)?;
        admin.require_auth();

        if let Some(pending) = env
            .storage()
            .instance()
            .get::<Symbol, PendingTransfer>(&KEY_PENDING)
        {
            if pending.status == ProposalStatus::Active {
                return Err(GovernanceError::TransferAlreadyPending);
            }
        }

        if let Some(last_cancelled_at) = env
            .storage()
            .instance()
            .get::<Symbol, u64>(&KEY_LAST_CANCELLED_AT)
        {
            let now = env.ledger().timestamp();
            if now < last_cancelled_at.saturating_add(REPROPOSAL_COOLDOWN_SECONDS) {
                return Err(GovernanceError::ReproposalCooldownActive);
            }
        }
        if signers.is_empty() {
            return Err(GovernanceError::EmptySignerList);
        }
        if signers.len() > MAX_SIGNERS {
            return Err(GovernanceError::TooManySigners);
        }
        // Ensure signer list contains unique addresses. Duplicates would allow
        // the same key to be listed multiple times and potentially bypass
        // the multi-signer threshold semantics. We build an explicit
        // deduplicated `unique_signers` Vec that preserves order but
        // rejects duplicates.
        let mut unique_signers: Vec<Address> = Vec::new(&env);
        for signer in signers.iter() {
            if unique_signers.contains(&signer) {
                return Err(GovernanceError::DuplicateSigner);
            }
            unique_signers.push_back(signer);
        }
        if threshold == 0 {
            return Err(GovernanceError::ThresholdTooLow);
        }
        if threshold > unique_signers.len() {
            return Err(GovernanceError::ThresholdExceedsSignerCount);
        }
        if delay_seconds < MIN_TIMELOCK_SECONDS {
            return Err(GovernanceError::DelayTooShort);
        }

        let now = env.ledger().timestamp();
        let proposal_id: u32 = env
            .storage()
            .instance()
            .get(&KEY_PROPOSAL_COUNT)
            .unwrap_or(0)
            .saturating_add(1);
        env.storage().instance().set(&KEY_PROPOSAL_COUNT, &proposal_id);

        let pending = PendingTransfer {
            id: proposal_id,
            proposed_admin: proposed_admin.clone(),
            signers: unique_signers.clone(),
            threshold,
            executable_after: now.saturating_add(delay_seconds),
            approvals: Map::new(&env),
            proposed_at: now,
            status: ProposalStatus::Active,
        };
        env.storage().instance().set(&KEY_PENDING, &pending);

        env.events().publish(
            (Symbol::new(&env, "AdminTransferProposed"),),
            AdminTransferProposedEvent {
                proposed_admin,
                signers: unique_signers,
                threshold,
                executable_after: pending.executable_after,
                proposed_by: admin,
                timestamp: now,
            },
        );
        Ok(())
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    fn read_admin(env: &Env) -> Result<Address, GovernanceError> {
        env.storage()
            .instance()
            .get(&KEY_ADMIN)
            .ok_or(GovernanceError::NotInitialized)
    }
}
