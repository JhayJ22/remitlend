use soroban_sdk::contracterror;

/// Errors returned by the loan manager contract.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum LoanError {
    /// Loan with the given id does not exist.
    LoanNotFound = 1,
    /// Loan is not in a state that allows the requested transition.
    InvalidLoanState = 2,
    /// Caller is not authorized to perform this action.
    Unauthorized = 3,
    /// Amount is invalid (zero, negative, or exceeds limits).
    InvalidAmount = 4,
    /// Loan is not yet overdue.
    NotOverdue = 5,
    /// Arithmetic overflow occurred.
    Overflow = 6,
    /// Batch of loan ids exceeds the configured maximum batch size.
    BatchSizeTooLarge = 7,
}
