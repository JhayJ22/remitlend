#![no_std]

use soroban_sdk::{token, Address, Env};

#[derive(Clone, Debug, PartialEq)]
pub enum TokenValidationError {
    ZeroAmount,
    InvalidTokenAddress,
    BalanceDeltaMismatch,
    TransferFailed,
}

pub struct TokenValidator;

impl TokenValidator {
    /// Executes an inbound token transfer and verifies the exact received balance delta.
    /// Protects against fee-on-transfer tokens, rebasing tokens, or silent transfer failures.
    pub fn verify_inbound_transfer(
        env: &Env,
        token_address: &Address,
        from: &Address,
        recipient: &Address,
        expected_amount: i128,
    ) -> Result<i128, TokenValidationError> {
        if expected_amount <= 0 {
            return Err(TokenValidationError::ZeroAmount);
        }

        let token_client = token::Client::new(env, token_address);

        // Record pre-transfer balance
        let balance_before = token_client.balance(recipient);

        // Execute transfer from caller to recipient
        token_client.transfer(from, recipient, &expected_amount);

        // Record post-transfer balance
        let balance_after = token_client.balance(recipient);

        let actual_delta = balance_after
            .checked_sub(balance_before)
            .ok_or(TokenValidationError::BalanceDeltaMismatch)?;

        if actual_delta < expected_amount {
            return Err(TokenValidationError::BalanceDeltaMismatch);
        }

        Ok(actual_delta)
    }
}
