#![no_std]

use soroban_sdk::{contracttype, Address, Env, Symbol};

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct PriceRoundRecord {
    pub round_id: u64,
    pub price: i128,
    pub timestamp: u64,
    pub reporter: Address,
}

pub struct PriceHistoryBuffer;

impl PriceHistoryBuffer {
    pub const MAX_HISTORY_ROUNDS: u64 = 100;

    pub fn record_round(env: &Env, asset: Symbol, round_id: u64, price: i128, reporter: Address) {
        let record = PriceRoundRecord {
            round_id,
            price,
            timestamp: env.ledger().timestamp(),
            reporter,
        };

        // Ring buffer storage indexed by round_id modulo MAX_HISTORY_ROUNDS
        let ring_index = round_id % Self::MAX_HISTORY_ROUNDS;
        env.storage().persistent().set(&(asset, ring_index), &record);
    }

    pub fn get_round(env: &Env, asset: Symbol, round_id: u64) -> Option<PriceRoundRecord> {
        let ring_index = round_id % Self::MAX_HISTORY_ROUNDS;
        let record: PriceRoundRecord = env.storage().persistent().get(&(asset, ring_index))?;
        if record.round_id == round_id {
            Some(record)
        } else {
            None
        }
    }
}
