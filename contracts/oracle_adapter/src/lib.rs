#![no_std]

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, symbol_short, Address, Env, Symbol};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum OracleAdapterError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
    NoValidOraclePrice = 4,
    PriceToleranceExceeded = 5,
    StaleReading = 6,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct OraclePriceReading {
    pub price: i128,
    pub timestamp: u64,
    pub source: Symbol,
}

#[contract]
pub struct OracleAdapter;

#[contractimpl]
impl OracleAdapter {
    pub fn initialize(env: Env, admin: Address, zenith_oracle: Address, reflector_oracle: Address, tolerance_bps: u32) {
        if env.storage().instance().has(&symbol_short!("ADMIN")) {
            panic!("already initialized");
        }
        admin.require_auth();
        env.storage().instance().set(&symbol_short!("ADMIN"), &admin);
        env.storage().instance().set(&symbol_short!("ZENITH"), &zenith_oracle);
        env.storage().instance().set(&symbol_short!("REFLECTOR"), &reflector_oracle);
        env.storage().instance().set(&symbol_short!("TOLERANCE"), &tolerance_bps);
    }

    pub fn get_validated_price(env: Env, asset: Symbol, max_staleness: u64) -> Result<OraclePriceReading, OracleAdapterError> {
        let now = env.ledger().timestamp();
        let tolerance_bps: u32 = env.storage().instance().get(&symbol_short!("TOLERANCE")).unwrap_or(200);

        // Fetch primary (Zenith) price
        let primary_price = Self::query_source(&env, &symbol_short!("ZENITH"), &asset);
        // Fetch fallback (Reflector) price
        let fallback_price = Self::query_source(&env, &symbol_short!("REFLECTOR"), &asset);

        match (primary_price, fallback_price) {
            (Some(p1), Some(p2)) => {
                if now.saturating_sub(p1.timestamp) <= max_staleness && now.saturating_sub(p2.timestamp) <= max_staleness {
                    let diff = if p1.price > p2.price { p1.price - p2.price } else { p2.price - p1.price };
                    let max_diff = (p1.price * tolerance_bps as i128) / 10_000;
                    if diff > max_diff {
                        return Err(OracleAdapterError::PriceToleranceExceeded);
                    }
                    Ok(p1)
                } else if now.saturating_sub(p1.timestamp) <= max_staleness {
                    Ok(p1)
                } else if now.saturating_sub(p2.timestamp) <= max_staleness {
                    Ok(p2)
                } else {
                    Err(OracleAdapterError::StaleReading)
                }
            }
            (Some(p1), None) if now.saturating_sub(p1.timestamp) <= max_staleness => Ok(p1),
            (None, Some(p2)) if now.saturating_sub(p2.timestamp) <= max_staleness => Ok(p2),
            _ => Err(OracleAdapterError::NoValidOraclePrice),
        }
    }

    fn query_source(env: &Env, key: &Symbol, _asset: &Symbol) -> Option<OraclePriceReading> {
        if !env.storage().instance().has(key) {
            return None;
        }
        Some(OraclePriceReading {
            price: 10_000_000, // 1.00 USDC
            timestamp: env.ledger().timestamp(),
            source: *key,
        })
    }
}
