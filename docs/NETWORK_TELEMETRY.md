# Network capacity, bounded failover, and retry-storm telemetry (#857)

This document defines the operational contract for per-network transaction-submission telemetry, bounded RPC failover, and retry-storm alerting.

## Source of truth and money semantics

The Stellar network passphrase from `getStellarNetworkPassphrase()` remains the authoritative source of truth for transaction identity. Failover only changes which RPC **relay** receives an already-signed transaction envelope. The signed XDR, transaction hash, amount units (Stroops), asset, and memo are never rewritten. A failover endpoint with a mismatched network is rejected by `STELLAR_FAILOVER_NETWORKS` parsing before it can receive traffic.

When no failover endpoints are configured, behavior is the same as the pre-existing single-primary path: one endpoint, one circuit breaker, and the durable write queue for outages.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `STELLAR_FAILOVER_NETWORKS` | unset | JSON array of `{ label, rpcUrl, priority?, enabled? }`. Must target the same Stellar network as the primary endpoint. Invalid, duplicate, disabled, or wrong-network entries are skipped at startup. |
| `TX_SUBMISSION_MAX_FAILOVER_HOPS` | `3` | Maximum number of configured endpoints considered for one submission. Failover is therefore bounded and cannot fan out to every configured node. |
| `TX_SUBMISSION_MAX_ATTEMPTS` | `10` | Retry ceiling per durable write. Exhausted writes move to `dead_lettered` instead of retrying forever. |
| `TX_SUBMISSION_STORM_WINDOW_MS` | `60000` | Rolling window for throughput, error, throttle, and latency rates. |
| `TX_SUBMISSION_STORM_PENDING_THRESHOLD` | `50` | Pending durable-write depth that raises a retry-storm alert. |
| `TX_SUBMISSION_STORM_CONSECUTIVE_FAILURES` | `10` | Per-endpoint consecutive failures that raise a retry-storm alert. |
| `TX_SUBMISSION_STORM_THROTTLE_RATE_THRESHOLD` | `0.5` | Per-network throttle ratio that raises a retry-storm alert. |
| `TX_SUBMISSION_STORM_EVAL_INTERVAL_MS` | `5000` | Minimum interval between alert evaluations when called from hot paths. |
| `TX_SUBMISSION_STORM_COOLDOWN_MS` | `60000` | Minimum interval between repeated alerts. |
| `FAILOVER_ALERT_WEBHOOK` | unset | Optional webhook receiving alert raise/clear payloads. Webhook failure is logged and never blocks submission. |

## Endpoint and failover states

Configured endpoints are ordered by `priority` (primary is `0`). The primary is always considered first, so a recovered primary automatically receives traffic again.

| Circuit state | Numeric gauge value | Routing behavior |
| --- | --- | --- |
| `closed` | `0` | Endpoint is eligible for submission. |
| `half-open` | `1` | Endpoint is eligible for one bounded trial call. |
| `open` | `2` | Endpoint is skipped for this submission. |

For each submission:

1. `selectEndpointForSubmission()` considers at most `TX_SUBMISSION_MAX_FAILOVER_HOPS` enabled endpoints in priority order.
2. The first non-short-circuiting endpoint is selected; a transition changes the active endpoint id and persists a `failover_activated` or `failover_deactivated` event.
3. `NoHealthyEndpointError` means no endpoint in the hop bound is healthy. The signed transaction is queued durably, `failover_exhausted` is recorded, and the request returns `QUEUED` rather than losing the write.
4. Submission outcomes are recorded against the selected endpoint: `submitted`, `queued`, `failed`, `throttled`, `duplicate`, or `dead_lettered`.
5. Retry-storm indicators are evaluated on submission failures and replay passes. The alert is deduplicated and clears automatically when backpressure resolves.

Replay is bounded: a write that reaches `max_attempts` moves to `dead_lettered` with its signed payload preserved. Only `POST /admin/network-failover/dead-letters/{id}/redrive` can requeue it, and only while it is still dead-lettered.

## Telemetry surfaces

Prometheus (scraped from `GET /metrics`, requires `admin:indexer`):

| Metric | Labels | Meaning |
| --- | --- | --- |
| `tx_submission_total` | `network`, `outcome` | Submission attempts and resolved outcomes. |
| `tx_submission_duration_seconds` | `network` | Submission latency histogram. |
| `tx_submission_throttled_total` | `network` | RPC `TRY_AGAIN_LATER` responses. |
| `tx_submission_errors_total` | `network`, `error_class` | `transient`, `rejected`, `poll_error`, or `no_endpoint` errors. |
| `tx_submission_in_flight` | `network` | Active submissions. |
| `tx_submission_circuit_state` | `network` | `0`/`1`/`2` for closed/half-open/open. |
| `soroban_write_queue_depth` | — | Pending durable writes. |
| `soroban_write_queue_dead_letter_depth` | — | Dead-lettered writes. |
| `soroban_write_queue_dead_lettered_total` | — | Cumulative dead letters. |
| `tx_submission_storm_alert_active` | — | `1` while a retry-storm alert is active. |
| `tx_submission_failover_total` | `event_type` | Failover and storm transitions. |

`network` labels are endpoint ids from the small configured registry, so label cardinality is bounded.

The admin API returns the same data in a human-readable snapshot, including p50/p95/p99 latency, throughput per second, error/throttle rates, active endpoint, per-endpoint circuit state, queue depths, and storm-alert state. See `docs/api-reference.md#admin-endpoints`.

## Authorization and failure behavior

All new admin routes require the `admin:indexer` API key. They expose operational metadata only; no secret values and no signed XDR payloads are returned. Invalid `id` values or stale redrive targets are rejected before any mutation.

Telemetry writes are best-effort: a failed audit-event insert or webhook delivery is logged and does not alter transaction submission, balances, loan states, or money units. Admin reads are non-mutating except for the explicitly audited dead-letter redrive.

## Persistence and compatibility

Two additive migrations are introduced:

- `1810000000000_network-failover-events.js` creates the append-only `network_failover_events` table with indexes on `created_at`, `(network_id, created_at)`, and `(event_type, created_at)`.
- `1810000000001_soroban-write-queue-dead-letter.js` adds `max_attempts`, `dead_lettered_at`, and `dead_letter_reason` to `soroban_write_queue`, backfilling existing rows with `max_attempts = 10`.

No existing column type, money amount, event payload, or public API field is changed. Down migrations drop only the objects created above. Applications that do not set failover variables continue to route to the primary endpoint and see a single network in telemetry.

## Validation evidence

Run from `backend/`:

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest --config jest.config.ts --runInBand --selectProjects unit --runTestsByPath \
  src/__tests__/networkSubmission.failover.test.ts \
  src/__tests__/networkTelemetry.access.test.ts \
  src/services/__tests__/networkFailoverService.test.ts \
  src/services/__tests__/retryStormAlertService.test.ts \
  src/services/__tests__/sorobanWriteQueue.deadLetter.test.ts
npm run typecheck
```

The focused suite covers the successful path, bounded failover and failback, hop bounds, wrong-network rejection, no-healthy-endpoint queueing, idempotent queueing, dead-letter bounds, alert deduplication/recovery, access control, and dependency failures.
