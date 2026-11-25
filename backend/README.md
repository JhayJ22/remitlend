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

**A documented command no longer exists.**
The verification workflow reports the file, section, and missing script. Update
this README and `package.json` together in the same pull request.

## Financial SLO alert ownership and escalation

Every critical financial SLO alert is registered in
`ops/alerts/financial-slos.yaml` with a stable `alert_id`. Each entry must
declare all of the following; the `npm run ops:alerts:validate` script fails CI
if any field is missing, if an `alert_id` is duplicated, or if an owner or
escalation route is not in the on-call roster.

| Field | Description |
| --- | --- |
| `alert_id` | Stable identifier, e.g. `slo.settlement.lag.p99` |
| `owner` | Owning team from the on-call roster |
| `severity` | `sev1`, `sev2`, or `sev3` |
| `runbook` | Path to the runbook under `ops/runbooks/` |
| `escalation` | Ordered escalation route (primary, secondary, incident commander) |
| `slo` | The SLO expression and threshold the alert fires on |

Supported states for an alert are `firing`, `acknowledged`, `recovering`, and
`resolved`. Transitions are recorded in the `alert_events` table with the
acknowledging actor, so acknowledgement and recovery are auditable. Alerts are
read-only from the API; they are produced by the monitoring pipeline and cannot
be created or mutated by clients.

### Scheduled drill procedure

Run the drill quarterly (and before any major release) with:

```bash
npm run ops:drill -- --alert-id <alert_id> --dry-run   # validate routing only
npm run ops:drill -- --alert-id <alert_id>             # send test notification
npm run ops:drill:report -- --drill-id <drill_id>      # ack/recovery metrics
```

The drill sends a synthetic notification through the real escalation route,
records time-to-acknowledge and time-to-recovery, and writes a report. A drill
that fails to deliver a notification, or that exceeds the acknowledgement
target for the alert's severity, fails the command with a non-zero exit code.
Drills never touch production financial state; the synthetic alert carries a
`drill: true` marker and is excluded from SLO error budgets.

## Incident evidence bundles

`GET /api/ops/incidents/:incidentId/evidence` returns a bounded, redacted
evidence bundle for a financial incident. Bundles are reproducible from the
incident ID alone: the same incident ID yields the same bundle contents for the
same retention window.

The bundle schema (`contracts/ops/evidence-bundle.schema.json`) contains:

| Field | Description |
| --- | --- |
| `incidentId` | Incident identifier the bundle was requested for |
| `generatedAt` | Server timestamp (UTC, ISO 8601) the bundle was assembled |
| `requestRefs` | Bounded list of request IDs (max 200) |
| `traceRefs` | Bounded list of trace IDs (max 200) |
| `checkpointRefs` | Ledger checkpoint references at incident time |
| `stateRefs` | Pointers to authoritative state snapshots (no inline payloads) |
| `redaction` | Redaction profile applied, always `default` unless overridden |

Constraints and failure behavior:

- References are capped at 200 per list; larger incidents return a `413` with
  guidance to narrow the time window rather than a partial bundle.
- Redaction is on by default: PII, tokens, and full request bodies are stripped.
  An unredacted bundle requires the `ops:evidence:raw` scope and is audited.
- Bundles are access-controlled: the caller needs the `ops:evidence:read` scope
  and membership in the incident's owning team. Unauthorized requests return
  `403` without revealing whether the incident exists.
- Bundles are time-limited: links expire after 15 minutes and the stored bundle
  is retained for 30 days, after which the endpoint returns `410 Gone`.
- Unknown or expired incident IDs return `404`/`410` respectively; no partial
  bundle is ever returned.

Migration notes: the `incident_evidence` table and the `ops:evidence:*` scopes
are additive. Existing clients are unaffected; the endpoint is new and gated
behind the scopes above. No stored financial schema changes.

## Clock skew and authoritative timestamps

Each workflow has exactly one authoritative timestamp source. Services must not
derive financial validity from local clocks.

| Workflow | Authoritative timestamp |
| --- | --- |
| Quote validity | `quotes.created_at` (database clock) |
| Nonce / replay window | `nonces.issued_at` (database clock) |
| Authorization expiry | `authorizations.expires_at` (database clock) |
| Settlement | `settlements.settled_at` (ledger clock) |
| Provider callbacks | Provider-signed timestamp, cross-checked against database clock |

Clock drift is measured per service and per provider and exported as the
`slo.clock.drift.seconds` metric. Thresholds:

- Warn at 250 ms drift; page the owning team at 1 s drift.
- A service whose drift exceeds the threshold is marked `degraded` and its
  quote/nonce/authorization writes are rejected with `503` rather than accepted
  with a skewed timestamp.
- Skew must never extend validity: expiry checks use the authoritative
  timestamp, so a fast local clock cannot extend a quote, nonce, or
  authorization. This is covered by `npm run test:clock-skew`.

## Financial workflow coverage map

`quality/coverage-map.yaml` maps each critical journey (borrower, lender,
remittance, settlement, recovery) to the contract, backend, frontend, and e2e
tests that must exist. CI runs:

```bash
npm run quality:coverage:check   # fails if a mapped financial path lost evidence
```

The check fails when a journey listed in the map has no test in a required
layer, or when a changed financial path (matched by the map's path globs) has no
corresponding test change. Add the test and update the map in the same pull
request.

## Reproducible validation evidence

For changes touching any of the above, attach the following to the PR:

```bash
npm run ops:alerts:validate
npm run ops:drill -- --alert-id <alert_id> --dry-run
npm run test:clock-skew
npm run quality:coverage:check
npm test
```

Paste the command output (or the CI job link) into the PR description. The
commands are deterministic and require no network access or external services.
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
