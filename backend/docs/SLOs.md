# Service Level Objectives (SLOs)

This document defines the service-level indicators (SLIs) and objectives (SLOs) for the
critical borrower and lender journeys, spanning the frontend, API, indexer, RPC
confirmation, and notification dependencies. It also defines the alerting rules,
error-budget policy, and review cadence that keep these objectives actionable.

## Critical user journeys

| Journey | Actor | Description |
| --- | --- | --- |
| Loan request | Borrower | Submit a borrow request and see it accepted on-chain. |
| Loan repayment | Borrower | Submit a repayment and see the loan marked repaid. |
| Inspect eligible funds | Lender | Load the pool view and see up-to-date eligible funds. |
| Withdraw | Lender | Submit a withdrawal and see funds leave the pool. |

Each journey is decomposed into the same pipeline stages so that a single failure mode
can be attributed to the right dependency:

1. **Frontend** — user interaction to request dispatch.
2. **API** — request accepted and persisted by the backend.
3. **RPC confirmation** — transaction submitted and included in a block.
4. **Chain finality** — block reaches the configured confirmation depth.
5. **Indexer projection** — indexed state reflects the confirmed event.
6. **Notification** — user-facing notification delivered (where applicable).

## SLI definitions

Every SLI below specifies a precise event definition, an eligible denominator, and an
exclusion policy. Latency SLIs are measured as the fraction of eligible events that
complete within the target, i.e. `good_events / eligible_events`.

### SLI-1: Loan request submission latency (frontend + API)

- **Event definition:** time from the borrower's `POST /loans` request being received by
the API to the API returning a `202 Accepted` with a persisted loan id.
- **Eligible denominator:** all `POST /loans` requests that reach the API and are
authenticated as a borrower.
- **Exclusions:** requests rejected with `4xx` (validation, auth, rate limit); requests
  from synthetic/health-check probes; requests during a declared dependency outage
  (see *Dependency vs. application failures*).
- **Target:** 99% of eligible requests complete in < 800 ms over a 28-day window.

### SLI-2: Loan request chain finality latency (RPC confirmation + finality)

- **Event definition:** time from the API accepting the loan request to the transaction
  reaching the configured confirmation depth on-chain.
- **Eligible denominator:** all accepted loan requests that produce a submitted
  transaction.
- **Exclusions:** transactions dropped by the user before broadcast; transactions
  reverted by contract logic (counted separately as a correctness signal, not latency).
- **Target:** 99% of eligible transactions reach finality in < 90 s over a 28-day window.

### SLI-3: Loan repayment submission latency (frontend + API)

- **Event definition:** time from the borrower's `POST /loans/{id}/repay` request being
  received by the API to the API returning a `202 Accepted`.
- **Eligible denominator:** all authenticated repayment requests for loans in a
  repayable state.
- **Exclusions:** `4xx` responses; requests for loans already repaid or in a
  non-repayable state; synthetic probes.
- **Target:** 99% of eligible requests complete in < 800 ms over a 28-day window.

### SLI-4: Loan repayment chain finality latency (RPC confirmation + finality)

- **Event definition:** time from the API accepting the repayment to the transaction
  reaching the configured confirmation depth on-chain.
- **Eligible denominator:** all accepted repayment requests that produce a submitted
  transaction.
- **Exclusions:** user-dropped transactions; contract reverts (tracked as correctness).
- **Target:** 99% of eligible transactions reach finality in < 90 s over a 28-day window.

### SLI-5: Eligible funds inspection freshness (indexer projection)

- **Event definition:** time from a confirmed on-chain event that changes eligible funds
  to the indexer projecting that change into the API response for
  `GET /pools/{id}/eligible-funds`.
- **Eligible denominator:** all confirmed events that mutate eligible funds for a pool.
- **Exclusions:** events for pools flagged as paused or archived; events during a
  declared indexer reindex/backfill window.
- **Target:** 99% of eligible events are projected within 30 s over a 28-day window.

### SLI-6: Eligible funds inspection availability (frontend + API)

- **Event definition:** fraction of `GET /pools/{id}/eligible-funds` requests that return
  a `2xx` response with a non-stale projection (projection age within SLI-5 target).
- **Eligible denominator:** all authenticated lender requests to the eligible-funds
  endpoint.
- **Exclusions:** `4xx` responses; requests for pools the lender is not eligible to view;
  synthetic probes.
- **Target:** 99.9% of eligible requests succeed over a 28-day window.

### SLI-7: Withdrawal submission latency (frontend + API)

- **Event definition:** time from the lender's `POST /pools/{id}/withdraw` request being
  received by the API to the API returning a `202 Accepted`.
- **Eligible denominator:** all authenticated withdrawal requests for pools with
  withdrawable balance.
- **Exclusions:** `4xx` responses; requests exceeding the withdrawable balance;
  synthetic probes.
- **Target:** 99% of eligible requests complete in < 800 ms over a 28-day window.

### SLI-8: Withdrawal chain finality latency (RPC confirmation + finality)

- **Event definition:** time from the API accepting the withdrawal to the transaction
  reaching the configured confirmation depth on-chain.
- **Eligible denominator:** all accepted withdrawal requests that produce a submitted
  transaction.
- **Exclusions:** user-dropped transactions; contract reverts (tracked as correctness).
- **Target:** 99% of eligible transactions reach finality in < 90 s over a 28-day window.

### SLI-9: Notification delivery latency (notification dependency)

- **Event definition:** time from a confirmed journey event (loan accepted, repayment
  confirmed, withdrawal confirmed) to the corresponding notification being delivered to
  the user's configured channel.
- **Eligible denominator:** all confirmed journey events for users with notifications
  enabled.
- **Exclusions:** users with notifications disabled; events during a declared
  notification-provider outage.
- **Target:** 99% of eligible notifications delivered within 60 s over a 28-day window.

## Targets: submission vs. finality vs. projection lag

The three latency classes are deliberately separated so that a slow chain or a lagging
indexer is never conflated with a slow application:

| Class | SLIs | Target |
| --- | --- | --- |
| Transaction submission | SLI-1, SLI-3, SLI-7 | 99% < 800 ms |
| Chain finality | SLI-2, SLI-4, SLI-8 | 99% < 90 s |
| Indexer projection lag | SLI-5 | 99% < 30 s |
| Availability | SLI-6 | 99.9% |
| Notification delivery | SLI-9 | 99% < 60 s |

## Financial projection drift anomaly alerts

Analytics compares an **authoritative total** (derived from confirmed on-chain events)
against an **independent projected total** (derived from the analytics projection) at
each ledger checkpoint. A drift alert fires only when the two totals disagree beyond a
documented tolerance, so that rounding noise and repeated conditions do not page.

### Inputs and constraints

- `authoritativeTotal` and `projectedTotal` are integer minor units (exact money units,
  no floats). Both must be present and non-negative.
- `toleranceMinorUnits` is a non-negative integer documenting the accepted absolute
  difference for the checkpoint. It must be supplied explicitly; there is no implicit
  default.
- `checkpointIds` is a non-empty list of ledger checkpoint identifiers the comparison
  covers. Empty or unknown checkpoint sets are rejected.
- `observedAt` must be within the freshness window; stale comparisons (older than the
  checkpoint's projection freshness target, SLI-5) are rejected rather than alerted.

Invalid or stale inputs are rejected without emitting an alert and without mutating any
financial projection state (no partial side effects).

### Comparison and suppression

- Drift is `abs(authoritativeTotal - projectedTotal)` in minor units.
- An alert is actionable only when `drift > toleranceMinorUnits`.
- Repeated alerts for the same drift condition (same checkpoint set and same drift
  signature) are suppressed within the suppression window; the condition is re-surfaced
  only when the drift signature changes or the window elapses.

### Routing

Actionable alerts route to the analytics owner with runbook context and the affected
checkpoint IDs so responders can reproduce the comparison.

| Alert | Condition | User impact | Owner | Runbook | Threshold |
| --- | --- | --- | --- | --- | --- |
| `ProjectionDriftAnomaly` | `drift > toleranceMinorUnits` at a fresh checkpoint | Reported financial totals diverge from authoritative state | `@analytics-oncall` | `runbooks/projection-drift.md` | Any actionable drift after suppression |

## Alerting rules

Every alert is tied to user impact, has an owner, a runbook reference, and an
actionable threshold. Alerts fire on burn rate over a short and a long window so that
fast regressions page immediately while slow burns are caught before the budget is
exhausted.

| Alert | Condition | User impact | Owner | Runbook | Threshold |
| --- | --- | --- | --- | --- | --- |
| `LoanRequestSubmissionSlow` | SLI-1 burn rate | Borrowers wait to submit requests | `@backend-oncall` | `runbooks/loan-request-submission.md` | 14.4x over 1h and 6x over 6h |
| `LoanRequestFinalitySlow` | SLI-2 burn rate | Borrowers cannot confirm loans | `@chain-oncall` | `runbooks/chain-finality.md` | 14.4x over 1h and 6x over 6h |
| `RepaymentSubmissionSlow` | SLI-3 burn rate | Borrowers cannot submit repayments | `@backend-oncall` | `runbooks/repayment-submission.md` | 14.4x over 1h and 6x over 6h |
| `RepaymentFinalitySlow` | SLI-4 burn rate | Repayments not confirmed | `@chain-oncall` | `runbooks/chain-finality.md` | 14.4x over 1h and 6x over 6h |
| `EligibleFunds

/* … truncated 2344 chars — edit only what you need near the top … */
