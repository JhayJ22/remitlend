# Data Lineage Reference — Score Inputs

This document describes every data source that feeds into a borrower's credit
score, how each source is fetched and validated, and the transformation steps
that produce the final value stored in the `scores` table.

---

## Table of Contents

- [Overview](#overview)
- [Authoritative Sources](#authoritative-sources)
- [Data Flow](#data-flow)
- [Score Input Catalogue](#score-input-catalogue)
  - [contract\_events — LoanRepaid](#contract_events--loanrepaid)
  - [contract\_events — LoanDefaulted](#contract_events--loandefaulted)
  - [remittances — Remittance History](#remittances--remittance-history)
  - [Prior / Baseline](#prior--baseline)
- [Transformation Pipeline](#transformation-pipeline)
  - [Step 1 — Event Indexing](#step-1--event-indexing)
  - [Step 2 — Bayesian Update](#step-2--bayesian-update)
  - [Step 3 — Score Clamping](#step-3--score-clamping)
  - [Step 4 — Decay (periodic)](#step-4--decay-periodic)
  - [Step 5 — Redis Cache](#step-5--redis-cache)
  - [Step 6 — Reconciliation Override](#step-6--reconciliation-override)
- [Boundary & Staleness Behaviour](#boundary--staleness-behaviour)
- [Observability](#observability)
- [Threat Model Notes](#threat-model-notes)
- [Compatibility Impact](#compatibility-impact)
- [Rollout Steps](#rollout-steps)

---

## Overview

RemitLend converts a borrower's on-chain behaviour — loan repayments,
defaults, and remittance transfers — into a credit score in the **300–850**
range (matching FICO conventions). The score gates loan eligibility and
interest-rate tiers.

Three code paths write to the `scores` table:

| Path | Trigger | Authority |
|------|---------|-----------|
| `bayesianScoringService` | New `contract_event` indexed | Derived from chain data |
| `scoreDecayService` | Scheduled cron | Time-based penalty |
| `scoreReconciliationService` | On-demand / scheduled | On-chain truth wins |

---

## Authoritative Sources

| Source | Location | Owner | Freshness SLA |
|--------|----------|-------|---------------|
| Stellar Horizon / Soroban RPC | External | Stellar Foundation | ~5 s per ledger |
| `contract_events` table | PostgreSQL | Backend indexer | ≤ one ledger behind |
| `remittances` table | PostgreSQL | Backend API | On-write |
| `scores` table | PostgreSQL | Scoring services | ≤ 60 s after event |
| Redis score cache | Redis | `cacheService` | TTL 300 s |

The Stellar ledger is the **ultimate authority**. Any discrepancy between the
database and on-chain state must be resolved in favour of on-chain state by
running `scoreReconciliationService`.

---

## Data Flow

```
Stellar Soroban RPC
        │
        ▼
 eventIndexer.ts  ──── indexes new contract events ────► contract_events
        │
        ▼ (LoanRepaid / LoanDefaulted events)
 bayesianScoringService.ts
        │
        ├─── reads: contract_events (address, event_type)
        ├─── reads: scores (current_score)
        │
        ▼
  Bayesian posterior score  ──────────────────────────► scores (upsert)
        │
        ▼
  cacheService.delete(score:userId:*)                 ► Redis cache busted
        │
        ▼ (periodic cron — configurable interval)
 scoreDecayJob.ts  ──── applies decay ──────────────► scores (update)
        │
        ▼ (reconciliation run)
 scoreReconciliationService.ts
        ├─── reads on-chain state via sorobanService
        └─── overwrites scores with setAbsoluteUserScoresBulk
```

---

## Score Input Catalogue

### `contract_events` — LoanRepaid

| Field | Column | Type | Notes |
|-------|--------|------|-------|
| Borrower address | `address` | `varchar(255)` | Renamed from `borrower` in migration 1788000000018 |
| Event type | `event_type` | `varchar(50)` | `'LoanRepaid'` |
| Ledger sequence | `ledger` | `integer` | Stellar ledger number — used for ordering |
| Ledger closed at | `ledger_closed_at` | `timestamp` | Wall-clock time of the ledger |
| Transaction hash | `tx_hash` | `varchar(255)` | Used for deduplication |
| Contract ID | `contract_id` | `varchar(255)` | Identifies the lending-pool contract |
| Amount | `amount` | `numeric` | XLM in stroops (integer after migration 1802000000000) |

**Score effect:** positive delta toward 850. Each repayment shifts the
Bayesian posterior mean upward.

### `contract_events` — LoanDefaulted

Same schema as `LoanRepaid` with `event_type = 'LoanDefaulted'`.

**Score effect:** negative delta toward 300. A default shifts the posterior
mean downward and increases variance (wider credible interval).

### `remittances` — Remittance History

| Field | Column | Type | Notes |
|-------|--------|------|-------|
| User ID | `user_id` | `varchar(255)` | Foreign key to `scores.user_id` |
| Amount | `amount` | `numeric` | Remittance amount |
| Sent at | `sent_at` | `timestamp` | |
| Status | `status` | `varchar(50)` | Only `'confirmed'` rows are used |

**Score effect:** remittance history feeds the initial prior — consistent
monthly transfers establish the baseline before any loan events exist.

### Prior / Baseline

| Parameter | Value | Source |
|-----------|-------|--------|
| `PRIOR_MEAN` | `500` | Hardcoded in `bayesianScoringService.ts` |
| `PRIOR_STDDEV` | `100` | Hardcoded in `bayesianScoringService.ts` |
| `BASE_SCORE` | `500` | Fallback when no `scores` row exists |

New users start at 500. The prior mean and standard deviation are tunable
constants — see [Compatibility Impact](#compatibility-impact) if you change
them.

---

## Transformation Pipeline

### Step 1 — Event Indexing

`eventIndexer.ts` polls the Soroban RPC for new events on configured
contract IDs. Each event is written to `contract_events` with a unique
`event_id` constraint to prevent duplicates. Events that fail validation are
placed in `quarantine_events` instead.

### Step 2 — Bayesian Update

`bayesianScoringService.calculateTieredScore(userId)` runs the following:

1. Queries `contract_events` for all `LoanRepaid` and `LoanDefaulted` rows
   matching the borrower address.
2. Reads the current score from `scores` (fallback: 500).
3. Computes a Bayesian posterior:

   ```
   posteriorVariance = 1 / (1/priorVariance + n/observedVariance)
   posteriorMean     = posteriorVariance × (priorMean/priorVariance
                       + n × observedMean/observedVariance)
   ```

4. Derives a confidence value (0–1) from posterior standard deviation.
5. Classifies the borrower into a tier:

   | Tier | Transaction Count |
   |------|------------------|
   | `initial` | 0–2 |
   | `developing` | 3–9 |
   | `established` | 10+ |

6. Returns a `TieredScore` including a 95 % credible interval
   (`[mean − 1.96σ, mean + 1.96σ]`, clamped to 300–850).

### Step 3 — Score Clamping

`scoresService.updateUserScoresBulk` enforces the hard floor/ceiling:

```sql
LEAST(850, GREATEST(300, scores.current_score + EXCLUDED.current_score - 500))
```

The reconciliation path (`setAbsoluteUserScoresBulk`) deliberately skips
application-level clamping so that mid-migration or contract-upgrade states
land verbatim. The database column has no CHECK constraint — clamping is
enforced in application code only.

### Step 4 — Decay (periodic)

`scoreDecayJob.ts` / `scoreDecayService.ts` runs on a configurable cron
schedule. Inactive borrowers receive a negative delta to reflect that stale
repayment history is less predictive. The decay magnitude is configurable via
environment variable (see [docs/ENVIRONMENT.md](ENVIRONMENT.md)).

### Step 5 — Redis Cache

After any write, the cache keys `score:userId:<userId>` and
`score:breakdown:<userId>` are deleted so the next read forces a DB query.
The cache TTL is **300 seconds** (5 minutes).

Score reads check Redis first; a cache miss re-runs the Bayesian query and
re-populates the cache.

### Step 6 — Reconciliation Override

`scoreReconciliationService` is the final arbiter. It:

1. Fetches canonical scores directly from the Soroban contract.
2. Calls `setAbsoluteUserScoresBulk` to overwrite any drift.
3. Busts all affected Redis cache entries.

This path takes precedence over all derived scores. Run it after any ledger
re-org or suspected data corruption.

---

## Boundary & Staleness Behaviour

| Scenario | Behaviour |
|----------|-----------|
| No loan events for new user | Score initialised to prior mean (500) |
| Indexer lag > 1 ledger | Score is stale; reconciliation run corrects it |
| Redis key missing | DB query runs; cache repopulated |
| Redis unavailable | Score read falls back to DB query; no score write fails |
| DB write fails | Error logged; exception propagated to caller; cache not busted |
| Score out of 300–850 range | Clamped on every non-reconciliation write |
| Duplicate contract event | Rejected by `event_id` unique constraint |
| Quarantined event | Excluded from scoring until manually reviewed |

---

## Observability

The following structured-log fields are emitted on every score write:

| Log event | Key fields |
|-----------|-----------|
| Bulk score update | `updatedCount`, `userId[]` |
| Reconciliation update | `updatedCount`, `userId[]` |
| Cache bust | `cacheKey` |
| Indexer error | `error`, `eventId` |

Metrics to monitor in production:

- `scores.updated_at` lag vs. wall clock (alert if > 5 min)
- Ratio of `LoanDefaulted` to `LoanRepaid` events (anomaly detection)
- Redis cache hit rate on `score:userId:*` keys
- Quarantine event queue depth

---

## Threat Model Notes

| Threat | Mitigation |
|--------|-----------|
| Score inflation by replaying repayment events | `event_id` unique constraint prevents duplicate events |
| Score spoofing via forged API payloads | All contract events originate from Soroban RPC; application cannot inject events without a valid on-chain transaction |
| Cache poisoning | Cache is invalidated — never written to directly from untrusted input; values always sourced from DB |
| Stale reconciliation leaving incorrect scores | Reconciliation runs on a schedule and can be triggered manually; on-chain source is authoritative |
| Score read bypassing cache in high-load scenarios | Cache miss cost is a single indexed DB query; connection pool limits bound concurrent reads |

---

## Compatibility Impact

- Changing `PRIOR_MEAN` or `PRIOR_STDDEV` constants changes scores for all
  users retroactively (recalculated on next cache miss). Co-ordinate with
  product if changing these values on a live system.
- Adding new event types to the scoring query is backward-compatible (existing
  scores are updated on the next event; no migration needed).
- Changing the clamping range (300–850) requires a database migration to add
  a CHECK constraint and a coordinated deploy of all scoring service code.

---

## Rollout Steps

1. No schema changes are required for this document.
2. If modifying the scoring constants, deploy backend with the new values and
   trigger a full reconciliation run to normalise all scores.
3. Verify using `GET /api/scores/:userId` that the response matches expected
   posterior values.
4. Monitor structured logs for `Failed to apply bulk user score updates` errors
   in the 30 minutes following any scoring service change.
