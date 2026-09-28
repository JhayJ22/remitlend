#![no_std]

use soroban_sdk::{contracterror, contracttype, symbol_short, Address, Env};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum HandoverError {
    Unauthorized = 1,
    NoActiveProposal = 2,
    ProposalExpired = 3,
    InvalidNewAdmin = 4,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct AdminProposal {
    pub proposed_admin: Address,
    pub proposed_at: u64,
    pub expires_at: u64,
}

pub struct AdminHandoverManager;

impl AdminHandoverManager {
    const PROPOSAL_TTL_SECS: u64 = 86400 * 3; // 3 days validity

    pub fn propose_admin(env: &Env, current_admin: &Address, new_admin: &Address) -> Result<(), HandoverError> {
        current_admin.require_auth();
        let stored_admin: Address = env.storage().instance().get(&symbol_short!("ADMIN")).unwrap();
        if current_admin != &stored_admin {
            return Err(HandoverError::Unauthorized);
        }

        let now = env.ledger().timestamp();
        let proposal = AdminProposal {
            proposed_admin: new_admin.clone(),
            proposed_at: now,
            expires_at: now + Self::PROPOSAL_TTL_SECS,
        };

        env.storage().instance().set(&symbol_short!("PEND_ADM"), &proposal);
        env.events().publish((symbol_short!("PROP_ADM"), new_admin), (proposal.expires_at,));
        Ok(())
    }

    pub fn accept_admin(env: &Env, caller: &Address) -> Result<(), HandoverError> {
        caller.require_auth();
        let proposal: AdminProposal = env.storage().instance().get(&symbol_short!("PEND_ADM"))
            .ok_or(HandoverError::NoActiveProposal)?;

        let now = env.ledger().timestamp();
        if now > proposal.expires_at {
            env.storage().instance().remove(&symbol_short!("PEND_ADM"));
            return Err(HandoverError::ProposalExpired);
        }

        if caller != &proposal.proposed_admin {
            return Err(HandoverError::Unauthorized);
        }

        env.storage().instance().set(&symbol_short!("ADMIN"), caller);
        env.storage().instance().remove(&symbol_short!("PEND_ADM"));
        env.events().publish((symbol_short!("ACC_ADM"), caller), ());
        Ok(())
    }
}
