# Settlement and Payout Exceptions

## Purpose and authority

The admin settlement dashboard is a read-only operational view of remittance
records, the reconciliation discrepancy ledger, and cross-contract
reconciliation state. It aggregates exception counts by source and age and
provides a bounded drill-down of up to 200 records.

The dashboard does not calculate balances, infer settlement completion, retry
transfers, or modify financial state. The underlying records and authoritative
on-chain/indexer reconciliation procedures remain the source of truth. No
amounts are aggregated or converted for this view.

## Exception definitions

| Type | Supported records | Detection rule |
|---|---|---|
| Delayed | Remittances | `pending` or `processing` for at least one hour |
| Unresolved | Remittances | Status is `failed` |
| Duplicate | Remittances | More than one row has the same non-null transaction hash |
| Mismatched | Reconciliation discrepancy ledger | Discrepancy status is `open` |
| Unresolved | Cross-contract reconciliation | State is `pending`, `half_applied`, or `failed` |

Age is measured from the source record's `created_at` or `detected_at` timestamp
to the query time, using these buckets: under 1 hour, 1–24 hours, 1–7 days, and
over 7 days. The source field is `remittances.source_type`, the discrepancy
class, or the cross-contract operation. The dashboard never treats a
provisional or self-reported remittance as authoritative settlement evidence.

## Access and API

`GET /api/v1/admin/settlement-exceptions` requires a valid JWT with the `admin`
role. It returns:

- Counts grouped by exception type, source, and age bucket, over all matching
  records.
- At most 200 newest detail rows, including their source status and recovery
  procedure link.

The endpoint is read-only. It has no action parameters and cannot submit or
retry a payout. Unauthorized requests are rejected by the admin JWT middleware.
If the database query fails, the API reports an error instead of returning a
success-shaped empty dashboard.

## Response to an exception

1. Open the source record using its `subjectRef` and verify the source state
   against the relevant transaction, ledger, or persisted event.
2. Follow the recovery procedure linked for that exception type.
3. Do not retry or reverse a financial action solely because it appears in the
   dashboard. First establish whether the original action committed and follow
   the applicable authorization and idempotency controls.
4. Record any operator decision through the existing audited reconciliation or
   dispute workflow. The dashboard itself does not resolve records.

### Delayed or failed remittances

Compare the remittance status, transaction hash, event/indexer state, and
authoritative Soroban result. For a `pending` or `processing` item, investigate
the original submission before retrying. Failed items require the remittance
recovery workflow and its existing idempotency controls.

### Duplicate payouts

The duplicate signal is based only on equal, non-null transaction hashes; it
does not establish that funds moved twice. Check the transaction's authoritative
chain result and all rows sharing the hash. Do not issue compensating transfers
until the duplicate is confirmed and the required approval process is followed.

### Mismatched settlement records

Review the discrepancy's immutable source snapshots and chain/indexer/database
values. Resolution of a discrepancy records an operator decision and does not
correct financial data. Use the existing dual-control reconciliation
resolution process where applicable.

### Unresolved cross-contract settlements

Compare the custody event and expected cross-contract side effect using the
recorded event ID, transaction hash, and ledger. Do not enable automatic
correction or submit on-chain repair as part of triage; follow the
cross-contract recovery and authorization controls.

## Compatibility and migration

This dashboard reads existing remittance and reconciliation tables and adds no
storage schema or API mutation. No data migration or rollback is required.
Records are presented in the smallest-unit/source representation already
stored; no monetary arithmetic is performed.
