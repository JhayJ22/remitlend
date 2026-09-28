#![no_std]

pub struct ProtocolRounding;

impl ProtocolRounding {
    /// Multiplies `a` and `b`, then divides by `denominator`, rounding towards negative infinity (floor).
    /// Used when calculating user payouts, interest claims, or token redemptions to favor protocol solvency.
    pub fn mul_div_floor(a: i128, b: i128, denominator: i128) -> Option<i128> {
        if denominator == 0 {
            return None;
        }
        let prod = a.checked_mul(b)?;
        let result = prod / denominator;
        let remainder = prod % denominator;
        if (remainder != 0) && ((prod < 0) ^ (denominator < 0)) {
            result.checked_sub(1)
        } else {
            Some(result)
        }
    }

    /// Multiplies `a` and `b`, then divides by `denominator`, rounding towards positive infinity (ceil).
    /// Used when calculating protocol fees, borrower interest liabilities, or collateral requirements.
    pub fn mul_div_ceil(a: i128, b: i128, denominator: i128) -> Option<i128> {
        if denominator == 0 {
            return None;
        }
        let prod = a.checked_mul(b)?;
        let result = prod / denominator;
        let remainder = prod % denominator;
        if (remainder != 0) && !((prod < 0) ^ (denominator < 0)) {
            result.checked_add(1)
        } else {
            Some(result)
        }
    }
}
