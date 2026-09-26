#![no_std]

use soroban_sdk::{contract, contracterror, contractimpl, symbol_short, Address, Env};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum CollateralError {
    Undercollateralized = 1,
    ZeroContracts = 2,
    Unauthorized = 3,
}

#[contract]
pub struct CallCollateralManager;

#[contractimpl]
impl CallCollateralManager {
    /// Computes and verifies required collateral for call options.
    /// Redesign ensures 100% full asset backing (1 unit of underlying asset per contract unit)
    /// to guarantee solvency against unbounded upside risk.
    pub fn verify_call_collateral(
        _env: Env,
        underlying_deposited: i128,
        contracts_minted: i128,
        contract_size: i128,
    ) -> Result<i128, CollateralError> {
        if contracts_minted <= 0 || contract_size <= 0 {
            return Err(CollateralError::ZeroContracts);
        }

        let required_collateral = contracts_minted
            .checked_mul(contract_size)
            .ok_or(CollateralError::Undercollateralized)?;

        if underlying_deposited < required_collateral {
            return Err(CollateralError::Undercollateralized);
        }

        Ok(required_collateral)
    }
}
