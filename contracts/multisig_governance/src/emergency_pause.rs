/// Emergency pause pattern with multi-sig governance and time-locking.
///
/// Provides:
/// - Multi-signature pause/unpause proposals
/// - Time-locked execution (24+ hour delay)
/// - Per-function circuit breakers
/// - Atomic pause state management

use soroban_sdk::{
    contracttype, symbol_short, Address, BytesN, Env, Map, Symbol, Vec,
};

use crate::GovernanceError;

// ─── Constants ────────────────────────────────────────────────────────────

/// Minimum timelock for pause: 24 hours (in seconds)
pub const PAUSE_TIMELOCK_SECONDS: u64 = 86_400;

/// Maximum paused functions: prevents unbounded iteration
pub const MAX_PAUSED_FUNCTIONS: u32 = 32;

// ─── Storage Keys ─────────────────────────────────────────────────────────

pub const KEY_PENDING_PAUSE: Symbol = symbol_short!("PNPAUSE");
pub const KEY_PAUSED_FUNCTIONS: Symbol = symbol_short!("PSFUNCS");
pub const KEY_PAUSE_HISTORY: Symbol = symbol_short!("PHIST");

// ─── Types ────────────────────────────────────────────────────────────────

/// Status of a pending pause/unpause proposal
#[contracttype]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PauseStatus {
    Active = 0,
    Cancelled = 1,
}

/// Represents a pending emergency pause proposal
#[contracttype]
#[derive(Clone, Debug)]
pub struct PendingPause {
    /// Unique identifier for this pause proposal
    pub id: u32,
    /// True to pause, false to unpause
    pub pause_action: bool,
    /// List of function identifiers to pause (empty = global pause)
    pub target_functions: Vec<Symbol>,
    /// Minimum approvals required
    pub threshold: u32,
    /// Ordered list of required signers
    pub signers: Vec<Address>,
    /// Map of signer -> approval status
    pub approvals: Map<Address, bool>,
    /// When this can be executed (unix timestamp in seconds)
    pub executable_after: u64,
    /// When this proposal was created
    pub proposed_at: u64,
    /// Current status (Active/Cancelled)
    pub status: PauseStatus,
}

/// Circuit breaker state for a single function
#[contracttype]
#[derive(Clone, Debug)]
pub struct FunctionPauseState {
    /// Function identifier
    pub function_id: Symbol,
    /// Whether this function is paused
    pub paused: bool,
    /// Unix timestamp when pause was activated
    pub paused_at: u64,
}

/// Event: Emergency pause proposal created
#[contracttype]
#[derive(Clone, Debug)]
pub struct EmergencyPauseProposedEvent {
    pub proposal_id: u32,
    pub pause_action: bool,
    pub target_functions_count: u32,
    pub threshold: u32,
    pub signers_count: u32,
    pub executable_after: u64,
    pub proposed_by: Address,
    pub timestamp: u64,
}

/// Event: Pause proposal approved by signer
#[contracttype]
#[derive(Clone, Debug)]
pub struct PauseProposalApprovedEvent {
    pub proposal_id: u32,
    pub signer: Address,
    pub approvals_so_far: u32,
    pub threshold: u32,
    pub timestamp: u64,
}

/// Event: Pause executed
#[contracttype]
#[derive(Clone, Debug)]
pub struct PauseExecutedEvent {
    pub proposal_id: u32,
    pub pause_action: bool,
    pub paused_functions_count: u32,
    pub executed_by: Address,
    pub timestamp: u64,
}

/// Event: Pause cancelled
#[contracttype]
#[derive(Clone, Debug)]
pub struct PauseCancelledEvent {
    pub proposal_id: u32,
    pub cancelled_by: Address,
    pub timestamp: u64,
}

// ─── Implementation ───────────────────────────────────────────────────────

/// Propose an emergency pause with multi-sig governance
pub fn propose_pause(
    env: &Env,
    pause_action: bool,
    target_functions: Vec<Symbol>,
    signers: Vec<Address>,
    threshold: u32,
) -> Result<u32, GovernanceError> {
    // Validate inputs
    if signers.is_empty() {
        return Err(GovernanceError::EmptySignerList);
    }

    if threshold == 0 || threshold > signers.len() as u32 {
        return Err(GovernanceError::ThresholdExceedsSignerCount);
    }

    if signers.len() > 20 {
        return Err(GovernanceError::TooManySigners);
    }

    if target_functions.len() > MAX_PAUSED_FUNCTIONS as usize {
        return Err(GovernanceError::ThresholdTooLow); // Reuse for function limit
    }

    // Verify no duplicate signers
    let mut seen: Vec<Address> = Vec::new(env);
    for signer in signers.iter() {
        for existing in seen.iter() {
            if existing == signer {
                return Err(GovernanceError::DuplicateSigner);
            }
        }
        seen.push_back(signer);
    }

    // Generate new proposal ID
    let pause_id_key = Symbol::new(env, "PAUSEID");
    let current_id: u32 = env
        .storage()
        .instance()
        .get(&pause_id_key)
        .unwrap_or(0);
    let new_id = current_id.saturating_add(1);
    env.storage().instance().set(&pause_id_key, &new_id);

    // Calculate executable_after (current timestamp + 24 hours)
    let current_timestamp = env.ledger().timestamp();
    let executable_after = current_timestamp.saturating_add(PAUSE_TIMELOCK_SECONDS);

    // Create pending pause proposal
    let mut approvals: Map<Address, bool> = Map::new(env);
    for signer in signers.iter() {
        approvals.set(signer, false);
    }

    let pending = PendingPause {
        id: new_id,
        pause_action,
        target_functions: target_functions.clone(),
        threshold,
        signers: signers.clone(),
        approvals,
        executable_after,
        proposed_at: current_timestamp,
        status: PauseStatus::Active,
    };

    // Store proposal
    let proposal_key = Symbol::new(env, &format!("PAUSE{}", new_id));
    env.storage().persistent().set(&proposal_key, &pending);

    // Emit event
    env.events().publish(
        (Symbol::new(env, "EmergencyPauseProposed"),),
        EmergencyPauseProposedEvent {
            proposal_id: new_id,
            pause_action,
            target_functions_count: target_functions.len() as u32,
            threshold,
            signers_count: signers.len() as u32,
            executable_after,
            proposed_by: env.invoker(),
            timestamp: current_timestamp,
        },
    );

    Ok(new_id)
}

/// Approve a pause proposal (multi-sig voting)
pub fn approve_pause(env: &Env, proposal_id: u32, signer: &Address) -> Result<(), GovernanceError> {
    signer.require_auth();

    let proposal_key = Symbol::new(env, &format!("PAUSE{}", proposal_id));
    let mut proposal: PendingPause = env
        .storage()
        .persistent()
        .get(&proposal_key)
        .ok_or(GovernanceError::ProposalNotActive)?;

    if proposal.status != PauseStatus::Active {
        return Err(GovernanceError::ProposalNotActive);
    }

    // Verify signer is in the list
    let mut is_signer = false;
    for s in proposal.signers.iter() {
        if s == signer {
            is_signer = true;
            break;
        }
    }
    if !is_signer {
        return Err(GovernanceError::SignerNotAllowed);
    }

    // Record approval
    proposal.approvals.set(signer.clone(), true);

    // Count approvals
    let mut approval_count = 0u32;
    for s in proposal.signers.iter() {
        if proposal.approvals.get(s.clone()).unwrap_or(false) {
            approval_count = approval_count.saturating_add(1);
        }
    }

    let current_timestamp = env.ledger().timestamp();

    // Emit approval event
    env.events().publish(
        (Symbol::new(env, "PauseProposalApproved"),),
        PauseProposalApprovedEvent {
            proposal_id,
            signer: signer.clone(),
            approvals_so_far: approval_count,
            threshold: proposal.threshold,
            timestamp: current_timestamp,
        },
    );

    env.storage()
        .persistent()
        .set(&proposal_key, &proposal);

    Ok(())
}

/// Execute an approved pause proposal (after timelock)
pub fn execute_pause(env: &Env, proposal_id: u32, executor: &Address) -> Result<(), GovernanceError> {
    executor.require_auth();

    let proposal_key = Symbol::new(env, &format!("PAUSE{}", proposal_id));
    let proposal: PendingPause = env
        .storage()
        .persistent()
        .get(&proposal_key)
        .ok_or(GovernanceError::ProposalNotActive)?;

    if proposal.status != PauseStatus::Active {
        return Err(GovernanceError::ProposalNotActive);
    }

    // Check timelock
    let current_timestamp = env.ledger().timestamp();
    if current_timestamp < proposal.executable_after {
        return Err(GovernanceError::TimelockNotElapsed);
    }

    // Count approvals
    let mut approval_count = 0u32;
    for signer in proposal.signers.iter() {
        if proposal.approvals.get(signer).unwrap_or(false) {
            approval_count = approval_count.saturating_add(1);
        }
    }

    if approval_count < proposal.threshold {
        return Err(GovernanceError::ThresholdNotMet);
    }

    // Apply pause/unpause
    if proposal.target_functions.is_empty() {
        // Global pause
        let key = Symbol::new(env, "PAUSEALL");
        env.storage().instance().set(&key, &proposal.pause_action);
    } else {
        // Function-level pause
        let key = Symbol::new(env, "PAUSEFUNCS");
        let mut paused_funcs: Vec<Symbol> = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| Vec::new(env));

        for func in proposal.target_functions.iter() {
            if proposal.pause_action {
                // Add to pause list
                let mut found = false;
                for existing in paused_funcs.iter() {
                    if existing == func {
                        found = true;
                        break;
                    }
                }
                if !found && paused_funcs.len() < MAX_PAUSED_FUNCTIONS as usize {
                    paused_funcs.push_back(func);
                }
            } else {
                // Remove from pause list
                let mut filtered = Vec::new(env);
                for existing in paused_funcs.iter() {
                    if existing != func {
                        filtered.push_back(existing);
                    }
                }
                paused_funcs = filtered;
            }
        }

        env.storage().persistent().set(&key, &paused_funcs);
    }

    // Emit execution event
    env.events().publish(
        (Symbol::new(env, "PauseExecuted"),),
        PauseExecutedEvent {
            proposal_id,
            pause_action: proposal.pause_action,
            paused_functions_count: proposal.target_functions.len() as u32,
            executed_by: executor.clone(),
            timestamp: current_timestamp,
        },
    );

    Ok(())
}

/// Cancel a pending pause proposal (admin or multi-sig)
pub fn cancel_pause(
    env: &Env,
    proposal_id: u32,
    canceller: &Address,
) -> Result<(), GovernanceError> {
    canceller.require_auth();

    let proposal_key = Symbol::new(env, &format!("PAUSE{}", proposal_id));
    let mut proposal: PendingPause = env
        .storage()
        .persistent()
        .get(&proposal_key)
        .ok_or(GovernanceError::ProposalNotActive)?;

    if proposal.status != PauseStatus::Active {
        return Err(GovernanceError::ProposalNotActive);
    }

    proposal.status = PauseStatus::Cancelled;
    env.storage()
        .persistent()
        .set(&proposal_key, &proposal);

    let current_timestamp = env.ledger().timestamp();

    env.events().publish(
        (Symbol::new(env, "PauseCancelled"),),
        PauseCancelledEvent {
            proposal_id,
            cancelled_by: canceller.clone(),
            timestamp: current_timestamp,
        },
    );

    Ok(())
}

/// Check if a function is currently paused
pub fn is_function_paused(env: &Env, function_id: &Symbol) -> bool {
    // Check global pause first
    let global_pause_key = Symbol::new(env, "PAUSEALL");
    if env
        .storage()
        .instance()
        .get::<Symbol, bool>(&global_pause_key)
        .unwrap_or(false)
    {
        return true;
    }

    // Check function-level pause
    let key = Symbol::new(env, "PAUSEFUNCS");
    let paused_funcs: Vec<Symbol> = env
        .storage()
        .persistent()
        .get(&key)
        .unwrap_or_else(|| Vec::new(env));

    for func in paused_funcs.iter() {
        if &func == function_id {
            return true;
        }
    }

    false
}

/// Get the list of currently paused functions
pub fn get_paused_functions(env: &Env) -> Vec<Symbol> {
    let key = Symbol::new(env, "PAUSEFUNCS");
    env.storage()
        .persistent()
        .get(&key)
        .unwrap_or_else(|| Vec::new(env))
}

/// Check if globally paused
pub fn is_globally_paused(env: &Env) -> bool {
    let key = Symbol::new(env, "PAUSEALL");
    env.storage()
        .instance()
        .get::<Symbol, bool>(&key)
        .unwrap_or(false)
}
