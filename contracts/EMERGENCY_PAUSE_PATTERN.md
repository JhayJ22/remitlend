# Emergency Pause Pattern with Multi-Sig Governance

## Overview

The emergency pause pattern provides a secure mechanism to pause or unpause critical contract functions using multi-signature governance and time-locking. This ensures that even if a single admin key is compromised, no emergency pause can be executed without explicit multi-signature consensus and a mandatory 24-hour delay.

## Architecture

### Three-Layer Protection

```
Layer 1: Multi-Signature Requirement
         ↓ (requires N-of-M signatures)
Layer 2: Time-Lock Delay  
         ↓ (requires 24+ hour wait)
Layer 3: Execution & Persistence
         ↓ (atomically applies pause state)
```

### Key Design Principles

1. **Not a Single Point of Failure**: Requires M-of-N signers (e.g., 2-of-3)
2. **Observable Intent**: Pause proposals are public and time-locked
3. **Per-Function Control**: Can selectively pause specific operations
4. **Global Override Available**: Optional global pause for extreme scenarios
5. **Auditability**: All pause events are on-chain and queryable

## Components

### Pause Types

#### Global Pause
Pauses all contract functionality immediately upon execution.

```rust
// Propose global pause
propose_emergency_pause(
    env,
    pause_action: true,           // true = pause, false = unpause  
    target_functions: Vec::new(), // empty = global pause
    signers: [addr1, addr2, addr3],
    threshold: 2                  // requires 2-of-3 signatures
)?;
```

#### Function-Level Circuit Breaker
Pauses specific functions while others remain operational.

```rust
// Pause only loan approval and collateral operations
propose_emergency_pause(
    env,
    pause_action: true,
    target_functions: vec![
        Symbol::new(&env, "approve_loan"),
        Symbol::new(&env, "seize_collateral"),
    ],
    signers: [addr1, addr2, addr3],
    threshold: 2
)?;
```

### Timelock Mechanism

All pause proposals include a mandatory 24-hour delay:

```
T+0h:   Proposal created
        - Signers notified
        - Proposal ID generated
        - Earliest execution time calculated

T+0-24h: Signature gathering
        - Signers approve proposal
        - Approvals accumulated
        - Threshold checked

T+24h:  Execution window opens
        - Anyone can trigger execution (if threshold met)
        - Observable delay ensures transparency
        - Community has time to react

T+∞:    Pause remains active until unpause proposal executed
```

### Storage Structure

```rust
PendingPause {
    id: u32,                          // Unique proposal ID
    pause_action: bool,               // true = pause, false = unpause
    target_functions: Vec<Symbol>,    // Empty = global, otherwise selective
    threshold: u32,                   // Minimum signatures required
    signers: Vec<Address>,            // Authorized signers (max 20)
    approvals: Map<Address, bool>,    // Who has signed
    executable_after: u64,            // Unix timestamp (current + 24h)
    proposed_at: u64,                 // Proposal creation time
    status: PauseStatus,              // Active or Cancelled
}
```

## Workflow

### Proposing an Emergency Pause

**Actor**: Any authorized party (typically admin or governance DAO)

```rust
proposal_id = propose_emergency_pause(
    env,
    pause_action: true,                    // Pause, not unpause
    target_functions: ["approve_loan"],    // Or empty for global
    signers: [signer1, signer2, signer3],  // The 3 authorized signers
    threshold: 2                            // Requires 2-of-3
)?;
// Returns: proposal ID for future reference
```

**Effects**:
- Creates PendingPause in storage
- Emits `EmergencyPauseProposed` event
- Sets executable_after to now + 24 hours
- Signers notified (off-chain or via event subscription)

### Gathering Signatures

**Actor**: Each authorized signer

```rust
// Signer 1 approves
approve_emergency_pause(env, proposal_id)?;
// Event: PauseProposalApproved { approvals_so_far: 1/2 }

// Signer 2 approves  
approve_emergency_pause(env, proposal_id)?;
// Event: PauseProposalApproved { approvals_so_far: 2/2 }
// Threshold reached! Ready for execution when timelock expires.
```

**Requirements**:
- Signer must be in the original signer list
- Signer must sign the transaction
- Duplicate approvals are idempotent (safe to retry)
- Approvals cannot be revoked (intentional - prevents race conditions)

### Executing the Pause

**Actor**: Anyone (typically operations team or bot)

```rust
// Wait until executable_after timestamp passes...

// After 24 hours have elapsed:
execute_emergency_pause(env, proposal_id)?;
```

**Checks**:
- Timelock has elapsed (current_time >= executable_after)
- Threshold of signatures has been met
- Proposal status is Active (not cancelled)

**Effects**:
- Applies pause/unpause state to targeted functions
- Updates PAUSEFUNCS or PAUSEALL storage
- Emits `PauseExecuted` event
- Proposal remains in history for audit

### Cancelling a Proposal

**Actor**: Admin or any signer

```rust
// Before execution window, cancel the proposal
cancel_emergency_pause(env, proposal_id)?;
// Event: PauseCancelled { ... }
```

**Use cases**:
- Proposal no longer needed
- False alarm response
- Emergency resolved before execution
- Incorrect proposal parameters

## Circuit Breaker Integration

### In Contract Code

When implementing critical functions, check pause status:

```rust
pub fn approve_loan(env: Env, borrower: Address, amount: i128) -> Result<()> {
    // Check if this function is paused
    if governance::is_function_paused(env.clone(), symbol_short!("LoanApprv")) {
        return Err(LoanError::OperationPaused);
    }
    
    // ... rest of implementation
}

pub fn seize_collateral(env: Env, borrower: Address) -> Result<()> {
    // Global pause also blocks this
    if governance::is_globally_paused(env.clone()) {
        return Err(LoanError::SystemPaused);
    }
    
    if governance::is_function_paused(env.clone(), symbol_short!("ColSeize")) {
        return Err(LoanError::OperationPaused);
    }
    
    // ... rest of implementation
}
```

### Query API

```rust
// Check specific function
is_paused = is_function_paused(env, "approve_loan")?;

// Get all paused functions
paused_funcs = get_paused_functions(env)?;
// Returns: ["approve_loan", "seize_collateral"]

// Check global pause
global_paused = is_globally_paused(env)?;
```

## Security Properties

### Threat Models Addressed

| Threat | Mitigation |
|--------|-----------|
| Compromised single admin key | Requires M-of-N signatures |
| Unauthorized pause | Multi-sig consensus required |
| Too-fast pause execution | 24-hour mandatory delay |
| Accidental pause | Cancel mechanism available |
| Pause for wrong functions | Function-level targeting |
| Loss of pause capability | Can re-pause after unpause |

### Assumptions

- Signers are trusted (compromise of M signers is equivalent to system compromise)
- Blockchain time is accurate (24h delay relies on ledger.timestamp())
- Signers monitor for pause proposals (off-chain notification required)
- Contract code respects pause checks (implementation must integrate properly)

## Emergency Procedures

### Scenario 1: Urgent Security Issue

**Situation**: Vulnerability discovered in loan approval logic

**Action**:
1. Initiate pause proposal for `approve_loan` function
2. Have 2 of 3 signers approve immediately
3. Wait 24 hours for timelock
4. Execute pause at T+24h
5. Fix vulnerability in code
6. Deploy patched contract
7. Propose unpause
8. Execute unpause after second 24-hour timelock

**Timeline**: ~2 days (48 hours including fix time)

### Scenario 2: Total System Halt

**Situation**: Widespread vulnerability affecting multiple contracts

**Action**:
1. Initiate global pause (empty target_functions)
2. Expedite signer approvals
3. Execute after timelock
4. All functions immediately reject with `SystemPaused`
5. Coordinate patched deployment
6. Unpause once deployed and tested

**Timeline**: 24+ hours

### Scenario 3: Accidental Pause

**Situation**: Pause proposal submitted with wrong parameters

**Action**:
1. Before timelock expires, cancel proposal
2. Submit corrected proposal
3. Resume normal signing process

**Timeline**: Immediate (no cost if caught quickly)

### Scenario 4: Partial Resume

**Situation**: One function fixed, others still broken

**Action**:
1. Propose unpause with target_functions = ["fixed_function"]
2. Get 2-of-3 signatures
3. After 24 hours, execute partial unpause
4. System partially operational while others remain paused
5. Repeat for each fixed function

**Timeline**: 24h per function

## Event Auditing

All pause-related events are emitted on-chain:

```rust
// Event: EmergencyPauseProposed
{
    proposal_id: 1,
    pause_action: true,
    target_functions_count: 2,
    threshold: 2,
    signers_count: 3,
    executable_after: 1725000000,
    proposed_by: "GABBCDE...",
    timestamp: 1724995000
}

// Event: PauseProposalApproved
{
    proposal_id: 1,
    signer: "GAAAAA...",
    approvals_so_far: 1,
    threshold: 2,
    timestamp: 1724995100
}

// Event: PauseExecuted
{
    proposal_id: 1,
    pause_action: true,
    paused_functions_count: 2,
    executed_by: "GAOOOO...",
    timestamp: 1725086000
}
```

## Configuration Best Practices

### Signer Selection

- **2-of-3**: Good balance of security and availability
- **3-of-5**: For larger security teams
- **2-of-2**: Maximum security, but single signer unavailability prevents unpause

### Function Coverage

- **Core Operations**: Always include
  - Loan approval
  - Collateral seizure
  - Fund withdrawal
  - Interest rate updates

- **Admin Functions**: Usually include
  - Configuration changes
  - Fee adjustments
  - Emergency functions

- **View-Only**: Never pause
  - Get balance
  - Check status
  - Query history

### Timelock Duration

- **24 hours**: Standard (default)
- **48 hours**: For less frequent operations
- **1 hour**: Only for specific pre-planned maintenance windows

Never use 0-hour timelock (defeats purpose).

## Implementation Checklist

- [ ] Deploy multisig_governance contract with emergency_pause module
- [ ] Configure signers and threshold (e.g., 2-of-3)
- [ ] Integrate pause checks in all critical functions
- [ ] Set up event monitoring for pause proposals
- [ ] Document pause procedures for team
- [ ] Create runbook for emergency scenarios
- [ ] Test pause/unpause flows in testnet
- [ ] Verify timelock enforcement
- [ ] Confirm event emission in all scenarios
- [ ] Monitor governance contract for unexpected state

## Testing Strategy

### Unit Tests

```rust
#[test]
fn test_propose_pause_requires_valid_signers() { ... }

#[test]
fn test_execute_pause_requires_timelock() { ... }

#[test]
fn test_function_level_pause_does_not_affect_global() { ... }

#[test]
fn test_cancel_pause_before_timelock() { ... }

#[test]
fn test_is_function_paused_checks_both_global_and_specific() { ... }
```

### Integration Tests

- Propose → Approve → Execute full flow
- Multiple signers with different ordering
- Timelock enforcement edge cases
- Function-level and global pause interaction
- Cancel at various stages

### Simulation

- Test with actual timelock delays
- Verify event ordering and content
- Confirm state consistency across operations
- Validate error messages

## Monitoring & Alerting

### Key Metrics

- Pause proposals per day
- Average time to collect signatures
- Pause execution frequency
- Pause duration

### Alerts

```
⚠️  Pause proposal created
    - Function(s): ['approve_loan']
    - Signers: 2-of-3
    - Executable at: <timestamp>

⚠️  Pause proposal reached threshold
    - Ready for execution in: <time remaining>

🚨 Pause executed
    - Duration: estimate
    - Functions affected: N
    - Impact: <business impact>
```

## Related Documentation

- **Contract Architecture**: `ARCHITECTURE.md`
- **Smart Contract Patterns**: `contracts/README.md`
- **Size Optimization**: `WASM_OPTIMIZATION.md`
- **CI/CD Practices**: `.github/workflows/ci.yml`

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2024-08-26 | Initial emergency pause pattern |
