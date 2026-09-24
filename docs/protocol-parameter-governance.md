# Protocol Parameter Governance and Change Communication

This document defines the governance process for modifying protocol-level
parameters in RemitLend: which parameters exist, who is authorized to change
them, what the change lifecycle looks like, and how users and integrators are
notified.

---

## Authoritative parameters

The following parameters are enforced on-chain in the `multisig_governance`
and `loan_manager` contracts. They cannot be altered without following the
process described in this document.

### multisig_governance contract

| Parameter | Constant | Default | Description |
|---|---|---|---|
| Minimum timelock | `MIN_TIMELOCK_SECONDS` | 86 400 s (24 h) | Shortest allowed delay between proposal creation and execution |
| Maximum signers | `MAX_SIGNERS` | 20 | Upper bound on quorum size; keeps storage bounded |
| Proposal TTL | `PROPOSAL_TTL_SECONDS` | 604 800 s (7 days) | Time before an unexecuted proposal expires |
| Reproposal cooldown | `REPROPOSAL_COOLDOWN_SECONDS` | 3 600 s (1 h) | Enforced wait after a proposal is cancelled before a new one may be submitted |

### loan_manager upgrade proxy

| Parameter | Default | Description |
|---|---|---|
| Upgrade timelock | 48 h (~34 560 ledgers) | Minimum delay between scheduling and executing a WASM upgrade |

### lending_pool (runtime-configurable, governance-guarded)

| Parameter | Description |
|---|---|
| `interest_rate_bps` | Annual interest rate in basis points |
| `max_loan_amount` | Per-borrower maximum loan size in stroops |
| `min_remittance_count` | Minimum number of on-chain remittances required for credit eligibility |
| `liquidation_threshold` | Collateral-to-loan ratio that triggers liquidation |

> Runtime-configurable parameters are stored in contract state and can be
> updated via a governance proposal. Immutable constants (listed above) require
> a contract upgrade to change.

---

## Change authorization

| Change type | Required authorization |
|---|---|
| Runtime parameter update | Active governance proposal reaching quorum threshold with timelock elapsed |
| Contract upgrade (new WASM) | Same as above, plus 48 h upgrade-proxy timelock |
| Emergency parameter freeze | Emergency-pause signers (see `emergency_pause.rs`) |
| Documentation-only update | PR review — no on-chain action required |

The governance quorum threshold is itself a governance-controlled parameter.
Raising it requires a successful proposal under the current threshold.

---

## Proposal lifecycle

```
 Proposer                Signers                     Chain
    │                       │                           │
    ├─ propose_change() ────►│                           │
    │  (quorum, timelock)    │                           │
    │                        ├─ sign() [≥ threshold] ───►│
    │                        │                           │  MIN_TIMELOCK elapsed
    │                        │                           │  (min 24 h)
    ├─ execute_change() ─────────────────────────────────►│
    │                        │                           │  state written
    │                        │                           │
```

### Step-by-step

1. **Draft** — author opens a GitHub issue or PR describing the parameter,
   old value, proposed value, rationale, and risk assessment.  
   Use the ADR template at [`docs/adr/template.md`](./adr/template.md) for
   cross-layer changes.

2. **On-chain proposal** — a governance signer calls `propose_admin_transfer`
   (or the equivalent parameter-change entry point) with the desired quorum
   and a timelock ≥ `MIN_TIMELOCK_SECONDS`.

3. **Quorum collection** — required signers call `approve_transfer` within the
   `PROPOSAL_TTL_SECONDS` window.

4. **Timelock wait** — no action required; the contract enforces the delay
   automatically and rejects premature execution with `TimelockNotElapsed`
   (error 4010).

5. **Execution** — any signer calls the execute entry point once the timelock
   has elapsed.  The contract emits a structured event (see [Observability](#observability)).

6. **Communication** — maintainers update this document and `docs/deployed-contracts.md`
   in the same PR that records the proposal ID and new values.

### Cancellation

Any governance signer may cancel a pending proposal at any time before
execution.  After cancellation, a new proposal cannot be submitted until
`REPROPOSAL_COOLDOWN_SECONDS` (1 hour) has elapsed.

---

## Failure and retry paths

| Scenario | Contract error | Resolution |
|---|---|---|
| Execution attempted before timelock | `TimelockNotElapsed` (4010) | Wait and retry after timelock expires |
| Insufficient approvals at execution | `ThresholdNotMet` (4011) | Collect missing signatures before executing |
| Proposal expired (> 7 days, unapproved) | `ProposalExpired` (4016) | Wait for cooldown, then re-submit proposal |
| Duplicate signer | `DuplicateSigner` (4020) | Remove duplicate address from signer list |
| Quorum exceeds MAX_SIGNERS | `TooManySigners` (4008) | Reduce signer list to ≤ 20 |
| Reproposal submitted too soon | `ReproposalCooldownActive` (4015) | Wait 1 hour after last cancellation |

---

## Observability

The governance contract emits the following events that integrators and
monitoring systems should index:

| Event topic | Fields | When emitted |
|---|---|---|
| `(UPGRADE, SCHED, …)` | `scheduled_at`, `wasm_hash` | WASM upgrade scheduled |
| `(UPGRADE, EXEC, …)` | `wasm_hash`, `execution_ledger` | WASM upgrade executed |
| `(UPGRADE, CANCEL)` | — | WASM upgrade cancelled |

Backend audit-log entries are written to the `audit_logs` table for every
parameter-change execution.  Query them at:

```
GET /api/admin/audit-logs?type=governance
```

Prometheus counters and alert thresholds are defined in the staging deployment
configuration.  Add an alert for any `GovernanceError` emitted on-chain.

---

## Rollback

On-chain parameter rollbacks require a new governance proposal (there is no
single-step undo).  The procedure is:

1. Submit a new proposal with the previous value.
2. Collect quorum approvals.
3. Wait for the timelock.
4. Execute.

For contract upgrades, rollback also requires scheduling a new upgrade back to
the previous WASM hash (held in upgrade-proxy state) and waiting the full 48 h
upgrade timelock.  See [`contracts/UPGRADE_PROCESS.md`](../contracts/UPGRADE_PROCESS.md).

---

## Change communication

All parameter changes that affect user-facing behavior (interest rates, loan
limits, eligibility thresholds) must be communicated before execution:

1. **GitHub issue / PR** — open at least 48 hours before on-chain execution to
   allow community review.  Tag the issue `governance`.

2. **Docs update** — this file and `docs/deployed-contracts.md` must be updated
   in the same PR that records the change.

3. **API consumers** — changes to `lending_pool` parameters are reflected in
   the `/api/pools` response; consumers should poll or subscribe to the
   `pool.parameters_updated` webhook event.

4. **Changelog** — add a `CHANGELOG.md` entry under `## Unreleased` describing
   the parameter, old value, new value, and proposal ID.

---

## Threat model notes

- **Rogue signer**: a compromised key in the quorum can sign but cannot execute
  alone — the threshold and timelock together limit blast radius.  Rotate
  compromised keys via a new governance proposal before the 7-day TTL expires.
- **Timelock griefing**: an attacker who controls a majority of signers can
  push through any parameter change.  The 24 h minimum timelock provides a
  window for the community to respond.  Emergency pause (see
  `contracts/EMERGENCY_PAUSE_PATTERN.md`) can freeze the protocol if a
  malicious proposal reaches execution.
- **Front-running**: parameter changes are visible on-chain once proposed.
  Financial parameters (rates, thresholds) should be changed in a single
  ledger execution to avoid partial-state arbitrage.

---

## Compatibility impact

Changes to immutable constants require a contract upgrade and therefore trigger
the 48 h upgrade timelock on top of the 24 h governance timelock.  API
consumers that cache contract-level parameters must be re-notified.  See
[`docs/adr/template.md`](./adr/template.md) for the full compatibility
checklist.
