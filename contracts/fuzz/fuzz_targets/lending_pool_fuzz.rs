#![no_main]

//! Fuzz target for the LendingPool contract — issue #807.
//!
//! After every random operation (deposit, withdraw, distribute_yield) the
//! target asserts the three runtime invariants introduced in issue #807:
//!
//!   INV-RT-1  Share price is monotonically non-decreasing (non-withdrawal ops).
//!   INV-RT-2  total_managed ≥ total_deposits (no dilution).
//!   INV-RT-3  pool_balance + total_outstanding ≤ total_managed (conservation).
//!
//! Because the contract now calls `assert_invariants` itself after each
//! state-changing operation (panicking with `InvariantViolation` on failure),
//! a successful call already proves the invariants held *during* the call.
//! The fuzz target adds an independent cross-check by reading the pool stats
//! after the fact, so that any regression in the assertion logic itself is
//! also caught.

use arbitrary::Arbitrary;
use lending_pool::{LendingPool, LendingPoolClient};
use libfuzzer_sys::fuzz_target;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::token::{Client as TokenClient, StellarAssetClient};
use soroban_sdk::{Address, Env, IntoVal, Symbol, Val};
use std::collections::HashMap;
use std::panic::AssertUnwindSafe;

macro_rules! rcall {
    ($env:expr, $client:expr, $func:expr, ($($arg:expr),*)) => {
        $env.try_invoke_contract::<Val, Val>(
            &$client.address,
            &Symbol::new($env, $func),
            ($($arg.clone(),)*).into_val($env)
        )
    };
}

#[derive(Arbitrary, Debug)]
enum FuzzAction {
    Deposit { user_id: u8, amount: i128 },
    Withdraw { user_id: u8, amount: i128 },
    DistributeYield { amount: i128 },
    GetDeposit { user_id: u8 },
    MultipleOperations { operations: Vec<Operation> },
}

#[derive(Arbitrary, Debug)]
struct Operation {
    user_id: u8,
    amount: i128,
    /// true = deposit, false = withdraw
    is_deposit: bool,
}

fn setup_token_contract<'a>(
    env: &Env,
    admin: &Address,
) -> (Address, StellarAssetClient<'a>, TokenClient<'a>) {
    let contract_id = env.register_stellar_asset_contract_v2(admin.clone());
    let stellar_asset_client = StellarAssetClient::new(env, &contract_id.address());
    let token_client = TokenClient::new(env, &contract_id.address());
    (contract_id.address(), stellar_asset_client, token_client)
}

/// Assert the three pool invariants from issue #807 against live pool stats.
///
/// This is an *independent* post-operation check: the contract already asserts
/// them inside each call, but we re-verify here so that any regression in the
/// assertion helper itself is caught by the fuzzer.
fn assert_pool_invariants(
    pool_client: &LendingPoolClient<'_>,
    token_id: &Address,
    token_client: &TokenClient<'_>,
    pool_id: &Address,
    prev_managed: i128,
    prev_shares: i128,
    is_withdrawal: bool,
) {
    let stats = pool_client.get_pool_stats(token_id);
    let new_managed = stats.total_managed_assets;
    let new_shares  = stats.total_shares;
    let total_deps  = stats.total_deposits;
    let pool_bal    = token_client.balance(pool_id);
    // total_outstanding is not directly in PoolStats, use the difference.
    // In fuzz scenarios there are no active loans, so outstanding == 0.
    // We conservatively check: pool_balance <= total_managed.
    let outstanding = 0i128;

    // INV-RT-1: share price non-decreasing (deposit and distribute_yield only).
    // Using virtual offset V = 1_000 as in the contract.
    let v: i128 = 1_000;
    if !is_withdrawal && prev_shares > 0 && new_shares > 0 {
        let lhs = new_managed.saturating_mul(prev_shares.saturating_add(v));
        let rhs = prev_managed.saturating_mul(new_shares.saturating_add(v));
        assert!(
            lhs >= rhs,
            "INV-RT-1 violated: share price decreased (new_managed={} new_shares={} \
             prev_managed={} prev_shares={})",
            new_managed, new_shares, prev_managed, prev_shares,
        );
    }

    // INV-RT-2: no dilution — total_managed >= total_deposits.
    assert!(
        new_managed >= total_deps,
        "INV-RT-2 violated: total_managed ({}) < total_deposits ({})",
        new_managed, total_deps,
    );

    // INV-RT-3: conservation — pool_balance + total_outstanding <= total_managed.
    let deployed = pool_bal.saturating_add(outstanding);
    assert!(
        deployed <= new_managed,
        "INV-RT-3 violated: pool_balance+outstanding ({}) > total_managed ({})",
        deployed, new_managed,
    );
}

fuzz_target!(|data: FuzzAction| {
    let env = Env::default();
    env.mock_all_auths();

    // 1. Setup mock asset
    let token_admin = Address::generate(&env);
    let (token_id, stellar_asset_client, token_client) = setup_token_contract(&env, &token_admin);

    // 2. Setup LendingPool
    let pool_id = env.register(LendingPool, ());
    let pool_client = LendingPoolClient::new(&env, &pool_id);

    // 3. Initialize LendingPool with Token
    let pool_admin = Address::generate(&env);
    pool_client.initialize(&pool_admin);
    // Disable withdrawal cooldown for fuzz simplicity.
    pool_client.set_withdrawal_cooldown(&0);

    match data {
        FuzzAction::Deposit { user_id: _, amount } => {
            let user = Address::generate(&env);

            if amount <= 0 {
                return;
            }

            stellar_asset_client.mint(&user, &amount);

            // Snapshot pre-call state for invariant check.
            let stats_before = pool_client.get_pool_stats(&token_id);
            let prev_managed = stats_before.total_managed_assets;
            let prev_shares  = stats_before.total_shares;

            let result = pool_client.try_deposit(&user, &token_id, &amount, &0);

            if result.is_ok() {
                // Verify invariant: user deposit should be non-negative.
                let balance = pool_client.get_deposit(&user, &token_id);
                assert!(balance >= 0, "Balance should never be negative");

                // Independent invariant check (issue #807).
                assert_pool_invariants(
                    &pool_client, &token_id, &token_client, &pool_id,
                    prev_managed, prev_shares, false,
                );
            }
        }

        FuzzAction::Withdraw { user_id: _, amount } => {
            let user = Address::generate(&env);

            if amount <= 0 {
                return;
            }

            let deposit_amount = match amount.checked_mul(2) {
                Some(v) => v,
                None => return,
            };
            stellar_asset_client.mint(&user, &deposit_amount);
            let _ = pool_client.try_deposit(&user, &token_id, &deposit_amount, &0);

            let stats_before = pool_client.get_pool_stats(&token_id);
            let prev_managed = stats_before.total_managed_assets;
            let prev_shares  = stats_before.total_shares;

            let shares_held = pool_client.get_shares(&user, &token_id);
            if shares_held <= 0 {
                return;
            }
            let shares_to_withdraw = shares_held.min(amount);
            let result = pool_client.try_withdraw(&user, &token_id, &shares_to_withdraw, &0);

            if result.is_ok() {
                let balance_after = pool_client.get_deposit(&user, &token_id);
                assert!(balance_after >= 0, "Balance should never be negative");

                // Independent invariant check (issue #807) — is_withdrawal=true.
                assert_pool_invariants(
                    &pool_client, &token_id, &token_client, &pool_id,
                    prev_managed, prev_shares, true,
                );
            }
        }

        FuzzAction::DistributeYield { amount } => {
            if amount <= 0 {
                return;
            }

            // Seed a deposit first so shares exist for the price check.
            let seeder = Address::generate(&env);
            stellar_asset_client.mint(&seeder, &1_000_000);
            let _ = pool_client.try_deposit(&seeder, &token_id, &1_000_000, &0);

            let stats_before = pool_client.get_pool_stats(&token_id);
            let prev_managed = stats_before.total_managed_assets;
            let prev_shares  = stats_before.total_shares;

            let yield_src = Address::generate(&env);
            stellar_asset_client.mint(&yield_src, &amount);
            let result = pool_client.try_distribute_yield(&yield_src, &token_id, &amount);

            if result.is_ok() {
                // Independent invariant check (issue #807) — not a withdrawal.
                assert_pool_invariants(
                    &pool_client, &token_id, &token_client, &pool_id,
                    prev_managed, prev_shares, false,
                );
            }
        }

        FuzzAction::GetDeposit { user_id: _ } => {
            let user = Address::generate(&env);
            let balance = pool_client.get_deposit(&user, &token_id);
            assert!(balance >= 0, "Balance should never be negative");
        }

        FuzzAction::MultipleOperations { operations } => {
            let mut users: HashMap<u8, Address> = HashMap::new();

            for op in operations {
                let user_addr = users
                    .entry(op.user_id)
                    .or_insert_with(|| Address::generate(&env))
                    .clone();

                if op.is_deposit {
                    if op.amount <= 0 {
                        continue;
                    }

                    let stats_before = pool_client.get_pool_stats(&token_id);
                    let prev_managed = stats_before.total_managed_assets;
                    let prev_shares  = stats_before.total_shares;

                    stellar_asset_client.mint(&user_addr, &op.amount);
                    let result = pool_client.try_deposit(&user_addr, &token_id, &op.amount, &0);

                    if result.is_ok() {
                        // INV-RT-1 / INV-RT-2 / INV-RT-3 (issue #807)
                        assert_pool_invariants(
                            &pool_client, &token_id, &token_client, &pool_id,
                            prev_managed, prev_shares, false,
                        );
                    }
                } else {
                    if op.amount <= 0 {
                        continue;
                    }

                    let shares_held = pool_client.get_shares(&user_addr, &token_id);
                    if shares_held <= 0 {
                        continue;
                    }
                    let shares_to_withdraw = shares_held.min(op.amount);

                    let stats_before = pool_client.get_pool_stats(&token_id);
                    let prev_managed = stats_before.total_managed_assets;
                    let prev_shares  = stats_before.total_shares;

                    let result = pool_client.try_withdraw(&user_addr, &token_id, &shares_to_withdraw, &0);

                    if result.is_ok() {
                        // INV-RT-1 (skipped for withdrawal) / INV-RT-2 / INV-RT-3 (issue #807)
                        assert_pool_invariants(
                            &pool_client, &token_id, &token_client, &pool_id,
                            prev_managed, prev_shares, true,
                        );
                    }
                }
            }
        }
    }
});
