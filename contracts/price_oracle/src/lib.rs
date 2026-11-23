#![no_std]

pub mod history;

use history::{PriceHistoryBuffer, PriceRoundRecord};
use soroban_sdk::{contract, contracterror, contractimpl, symbol_short, Address, Env, Symbol};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum PriceOracleError {
    InsufficientPriceHistory = 1,
    Unauthorized = 2,
    InvalidPrice = 3,
}

#[contract]
pub struct PriceOracleContract;

#[contractimpl]
impl PriceOracleContract {
    pub fn record_price(
        env: Env,
        feeder: Address,
        asset_pair: Symbol,
        price: i128,
        timestamp: u64,
    ) -> Result<u64, PriceOracleError> {
        feeder.require_auth();
        if price <= 0 {
            return Err(PriceOracleError::InvalidPrice);
        }

        let latest: u64 = env
            .storage()
            .persistent()
            .get(&(asset_pair.clone(), symbol_short!("latest")))
            .unwrap_or(0);
        let next_round = latest + 1;

        PriceHistoryBuffer::record_round(
            &env,
            asset_pair,
            next_round,
            price,
            feeder,
            timestamp,
        );

        Ok(next_round)
    }

    pub fn get_twap(
        env: Env,
        asset_pair: Symbol,
        window_ledgers: u64,
    ) -> Result<i128, PriceOracleError> {
        let latest: u64 = env
            .storage()
            .persistent()
            .get(&(asset_pair.clone(), symbol_short!("latest")))
            .unwrap_or(0);

        if latest < 3 {
            return Err(PriceOracleError::InsufficientPriceHistory);
        }

        let window = if window_ledgers == 0 || window_ledgers > PriceHistoryBuffer::MAX_HISTORY_ROUNDS {
            PriceHistoryBuffer::MAX_HISTORY_ROUNDS
        } else {
            window_ledgers
        };

        let start_round = if latest >= window { latest - window + 1 } else { 1 };
        let count = latest - start_round + 1;

        if count < 3 {
            return Err(PriceOracleError::InsufficientPriceHistory);
        }

        let mut sum_price: i128 = 0;
        let mut valid_entries: i128 = 0;

        for r in start_round..=latest {
            if let Some(record) = PriceHistoryBuffer::get_round(&env, asset_pair.clone(), r) {
                sum_price += record.price;
                valid_entries += 1;
            }
        }

        if valid_entries < 3 {
            return Err(PriceOracleError::InsufficientPriceHistory);
        }

        Ok(sum_price / valid_entries)
    }
}
