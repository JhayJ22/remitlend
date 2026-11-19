# Backend

This directory contains the backend services for the project.

## Analytics: Historical Contract-State Snapshots

For audit queries, the analytics service persists **bounded, immutable contract-state
snapshots** at documented ledger checkpoints. Each snapshot is linked to the source
event range it was derived from and is validated against direct contract reads.

### Supported states

A snapshot captures the contract state at a single ledger checkpoint. Supported
snapshot states are:

- `pending` — snapshot record created, reconstruction not yet validated.
- `validated` — reconstruction matched the direct contract read at the checkpoint.
- `mismatch` — reconstruction diverged from the direct contract read; the snapshot is
  retained for audit but flagged as unreliable.
- `failed` — reconstruction or validation could not complete (dependency failure).

Only `validated` snapshots are served to audit queries by default; `mismatch` and
`failed` snapshots are retained for inspection and are never silently promoted.

### Input constraints

Snapshot requests are rejected (without any partial persistence) when:

- the requested ledger checkpoint is outside the documented, bounded checkpoint range;
- the source event range is empty or its start is after its end;
- the event range does not fall within the checkpoint window it claims to describe;
- a snapshot already exists for the same checkpoint and event range (idempotent replay
  returns the existing immutable snapshot rather than writing a new one).

### Authorization / consent

Creating or invalidating snapshots requires the analytics operator role. Read access to
snapshots follows the same authorization as the underlying audit queries. No snapshot
is created on behalf of a user without an explicit operator action.

### Failure behavior

Snapshot creation is transactional: either the snapshot record and its event-range link
are persisted together, or nothing is written. Validation failures mark the snapshot
`mismatch`/`failed` rather than deleting it, preserving the audit trail. Stale requests
(checkpoint already superseded by a newer validated snapshot) are rejected without
side effects.

### Persistence and compatibility

Snapshots are stored alongside the existing event/indexer schema and reference the
source event range by ledger bounds. The snapshot table is additive; existing event and
indexer records are unchanged. Consumers that do not read snapshots are unaffected.
Any future change to the stored snapshot schema must be documented here with its
migration implications before rollout.

## Analytics: Governed Data-Access Request Workflow

Analysts who need sensitive analytical data must go through a governed, auditable
access-request workflow. Every request states a purpose, selects a minimal dataset,
carries a bounded expiry, and names an approver. Grants and revocations are logged and
expired permissions are removed automatically.

### Supported states

An access request moves through the following states:

- `requested` — created by the requester with purpose, dataset, expiry, and approver.
- `approved` — an authorized approver (distinct from the requester) accepted the request.
- `granted` — the grantor/system materialized the permission for the approved request.
- `denied` — an authorized approver rejected the request.
- `revoked` — a previously granted permission was withdrawn before expiry.
- `expired` — the permission passed its expiry and was removed automatically.

Allowed transitions are `requested → approved | denied`, `approved → granted`,
`granted → revoked | expired`. Any other transition (e.g. `denied → granted`,
`revoked → granted`, `expired → granted`) is rejected as invalid or stale without any
partial side effects.

### Input constraints

Requests are rejected (without any partial persistence) when:

- the stated purpose is missing or empty;
- the dataset selection is empty or not a subset of the minimal dataset allowlist;
- the expiry is missing, in the past, or beyond the bounded maximum lifetime;
- the designated approver is missing or is the same principal as the requester.

### Authorization / consent

Only principals holding the approver role may approve or deny a request, and the
approver must be the designated approver on the request. Only the grantor role (or the
system, on approval) may grant. A requester can never approve or grant their own
request. Revocation requires the grantor role or the original approver.

### Audit logging

Every grant and revocation writes an immutable audit record capturing the actor, the
timestamp, the reason, and the dataset scope. Expiry-driven removals are logged the same
way with the system as actor. Audit records are append-only and are never mutated or
deleted.

### Failure behavior

State transitions are transactional: the request state change and its audit record are
persisted together, or nothing is written. Invalid or stale actions (wrong state, wrong
actor, expired request) are rejected without partial financial or permission side
effects. Automatic expiry removal is idempotent — replaying it for an already-expired
grant is a no-op.

### Persistence and compatibility

Access requests, grants, and audit records are stored in additive tables; existing
event and indexer records are unchanged. Consumers that do not read access requests are
unaffected. Any future change to the stored request/grant/audit schema must be
documented here with its migration implications before rollout.
