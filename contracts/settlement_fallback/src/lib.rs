#![no_std]

use soroban_sdk::{contract, contracterror, contractimpl, symbol_short, Address, Env};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum SettlementError {
    AlreadySettled = 1,
    GracePeriodNotElapsed = 2,
    Unauthorized = 3,
}

#[contract]
pub struct SettlementFallback;

#[contractimpl]
impl SettlementFallback {
    const SETTLEMENT_GRACE_PERIOD: u64 = 86400 * 2; // 2 days fallback grace

    pub fn emergency_fallback_settle(env: Env, caller: Address, market_id: u64, fallback_price: i128) -> Result<(), SettlementError> {
        caller.require_auth();
        let admin: Address = env.storage().instance().get(&symbol_short!("ADMIN")).unwrap();
        if caller != admin {
            return Err(SettlementError::Unauthorized);
        }

        let is_settled: bool = env.storage().persistent().get(&market_id).unwrap_or(false);
        if is_settled {
            return Err(SettlementError::AlreadySettled);
        }

        env.storage().persistent().set(&market_id, &true);
        env.events().publish((symbol_short!("EMERG_SET"), market_id), (fallback_price, caller));

        Ok(())
    }
}
