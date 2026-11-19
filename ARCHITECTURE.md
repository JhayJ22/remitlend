# Architecture

This document describes the high-level architecture of the project and the
contracts that govern cross-cutting capabilities. It is the authoritative
reference for state machines, authorization rules, and audit requirements.

## Analytics: Governed Data-Access Request Workflow

Sensitive analytical datasets are accessed only through a governed request
workflow. The workflow is auditable end to end: every state transition is
recorded with actor, timestamp, reason, and dataset scope, and expired grants
are removed automatically.

### Supported states

| State       | Meaning                                                        |
| ----------- | -------------------------------------------------------------- |
| `requested` | Requester submitted a purpose, dataset scope, and expiry.       |
| `approved`  | A designated approver accepted the request.                    |
| `granted`   | Access was provisioned by the grantor/system.                   |
| `denied`    | An approver rejected the request.                               |
| `revoked`   | A previously granted access was withdrawn.                      |
| `expired`   | A granted access passed its expiry and was removed.             |

Allowed transitions:

- `requested -> approved | denied`
- `approved -> granted`
- `granted -> revoked | expired`

Any other transition (including re-approving a `denied` request, granting an
unapproved request, or acting on an `expired`/`revoked` grant) is rejected as
invalid or stale. Rejections are atomic: no partial grant, revocation, or
financial side effect is applied.

### Input constraints

A request is valid only when all of the following hold:

- **Stated purpose** is present and non-empty.
- **Dataset scope** is a minimal, explicit selection (no wildcard/all-datasets
  grants).
- **Expiry** is bounded: it must be in the future and within the configured
  maximum grant window.
- **Approver** is designated and is distinct from the requester.

Invalid input is rejected at submission time with a validation error; nothing
is persisted.

### Authorization and consent

- Only authorized approvers may move a request to `approved` or `denied`.
- Only the grantor or the system may move `approved -> granted`.
- A requester cannot approve or grant their own request (no self-approval).
- Revocation requires an authorized actor and a recorded reason.

### Audit log

Every `granted`, `revoked`, and `expired` transition appends an immutable audit
record containing:

- actor (requester, approver, grantor, or `system` for expiry)
- timestamp
- reason
- dataset scope
- resulting state

Audit records are append-only and are the source of truth for access history.

### Expiry

A scheduled job (or equivalent system actor) transitions `granted` requests
whose expiry has passed to `expired`, removes the underlying permission, and
writes an audit record with actor `system`. Expiry is idempotent: re-running the
job on an already-expired grant is a no-op.

### Compatibility and migration

This workflow introduces new persisted records (requests and audit entries).
Existing access grants are treated as legacy and are not retroactively
re-validated; they are migrated to `granted` records with a recorded migration
reason and their existing expiry. Public API representations expose the state
enum above; adding new states is a backward-compatible change, while removing
or renaming states requires a versioned migration.

### Validation

Focused automated coverage should exercise the successful path plus boundary
cases (expiry bounds, empty purpose, wildcard scope), retry/idempotency (expiry
job re-runs), access control (self-approval, unauthorized approver), and
dependency failure (audit write failure rolls back the transition).
