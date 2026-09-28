#![no_std]

use soroban_sdk::{contract, contracterror, contractimpl, symbol_short, Address, Env};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum StakingError {
    InsufficientStake = 1,
    Unauthorized = 2,
    FeederNotFound = 3,
}

#[contract]
pub struct FeederStaking;

#[contractimpl]
impl FeederStaking {
    pub fn initialize(env: Env, admin: Address, insurance_fund: Address) {
        admin.require_auth();
        env.storage().instance().set(&symbol_short!("ADMIN"), &admin);
        env.storage().instance().set(&symbol_short!("INS_FUND"), &insurance_fund);
    }

    pub fn deposit_stake(env: Env, feeder: Address, amount: i128) {
        feeder.require_auth();
        let current_stake: i128 = env.storage().persistent().get(&feeder).unwrap_or(0);
        env.storage().persistent().set(&feeder, &(current_stake + amount));
    }

    pub fn slash_feeder(env: Env, admin: Address, feeder: Address, slash_amount: i128) -> Result<(), StakingError> {
        admin.require_auth();
        let stored_admin: Address = env.storage().instance().get(&symbol_short!("ADMIN")).unwrap();
        if admin != stored_admin {
            return Err(StakingError::Unauthorized);
        }

        let current_stake: i128 = env.storage().persistent().get(&feeder).unwrap_or(0);
        if current_stake < slash_amount {
            return Err(StakingError::InsufficientStake);
        }

        env.storage().persistent().set(&feeder, &(current_stake - slash_amount));

        let insurance_fund: Address = env.storage().instance().get(&symbol_short!("INS_FUND")).unwrap();
        env.events().publish((symbol_short!("SLASHED"), feeder), (slash_amount, insurance_fund));

        Ok(())
    }
}
