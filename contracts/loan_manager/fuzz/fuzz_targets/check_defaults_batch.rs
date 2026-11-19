#![no_main]

use libfuzzer_sys::fuzz_target;
use loan_manager::{LoanManager, LoanManagerClient, LoanError, MAX_BATCH_SIZE};
use soroban_sdk::{testutils::Address as _, Address, Env, Vec};

// Soroban enforces a per-transaction instruction budget. The batch default
// checker must never exceed it, regardless of how many loans are passed in or
// what state those loans are in. This fuzz target asserts that invariant by
// driving `check_defaults_batch` with arbitrary batch contents and verifying
// that every call either succeeds within budget or fails fast with
// `BatchSizeTooLarge` before doing any unbounded work.
fuzz_target!(|data: &[u8]| {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, LoanManager);
    let client = LoanManagerClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    client.initialize(&admin);

    // Derive a batch size from the fuzz input. We intentionally allow values
    // well above MAX_BATCH_SIZE to exercise the rejection path.
    let requested = if data.is_empty() {
        0u32
    } else {
        // Map the first byte into [0, 2 * MAX_BATCH_SIZE] so we cover both the
        // accepted range and the over-limit range.
        (data[0] as u32) % (MAX_BATCH_SIZE.saturating_mul(2).saturating_add(1))
    };

    let mut loan_ids: Vec<u64> = Vec::new(&env);
    for i in 0..requested {
        // Use arbitrary but deterministic ids; some may not exist, which must
        // be handled gracefully without unbounded iteration.
        let id = if data.len() > 1 {
            (data[1] as u64).wrapping_mul(i as u64 + 1)
        } else {
            i as u64
        };
        loan_ids.push_back(id);
    }

    let result = client.try_check_defaults_batch(&loan_ids);

    if requested > MAX_BATCH_SIZE {
        // Over-limit batches must be rejected before any iteration happens.
        assert_eq!(result, Err(Ok(LoanError::BatchSizeTooLarge)));
    } else {
        // Within-limit batches must complete without exhausting the instruction
        // budget. A successful call or a well-defined domain error are both
        // acceptable; a budget/instruction-limit trap is not.
        match result {
            Ok(_) => {}
            Err(Ok(_domain_error)) => {}
            Err(Err(_)) => panic!("batch default check exceeded instruction budget"),
        }
    }
});
