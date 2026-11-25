# Architecture

This document describes the high-level architecture of the project and the
contracts that connect its boundaries. It is the authoritative reference for
cross-cutting design decisions.

## Overview

The system is composed of a frontend application, a backend API, and shared
contracts. The frontend renders core account journeys (balances, transaction
details, transfers) against authoritative backend data. Money is always carried
as exact integer minor units; the frontend never performs floating-point money
math.

## Frontend

### Core account journeys

Core journeys are:

- Account overview and balances
- Transaction list and transaction details
- Transfer review and confirmation

These journeys must remain usable on constrained connections. Optional,
nonessential content may be deferred, but transaction details, security and
authorization checks, and stale-data warnings are never removed.

### Low-bandwidth rendering

The frontend exposes a supported connection state model for core journeys:

| State        | Meaning                                                        |
| ------------ | -------------------------------------------------------------- |
| `normal`     | Full rendering; all assets and optional content are loaded.    |
| `constrained`| Reduced assets; optional content is deferred or lazy-loaded.    |
| `offline`    | No network; cached data is shown with an explicit stale warning.|

Detection uses the browser's `navigator.connection` hints (effective type,
save-data) where available, falling back to `normal` when unsupported. The
state is advisory: it changes what is rendered, never what is authorized.

#### Rendering rules

- **Always rendered** in every state: transaction details (amount in exact
  minor units, currency, counterparty, timestamp, status), security and
  authorization checks, and explicit stale-data warnings when data may be
  outdated.
- **Deferred when `constrained` or `offline`**: decorative images, secondary
  widgets, and noncritical supplementary data. Deferred content must not block
  the core journey.
- **`offline`**: only cached data is shown, and it is always accompanied by a
  user-visible stale-data warning. Actions that require authoritative state
  (e.g. submitting a transfer) are disabled and rejected client-side.

#### Failure behavior

- Invalid or stale actions are rejected before any request is sent, so no
  partial financial side effects occur.
- When a request fails due to connectivity, the UI surfaces the failure and
  keeps the last known data visible with a stale warning; it does not silently
  retry financial mutations.
- Authorization and consent requirements are unchanged by connection state;
  constrained rendering never bypasses security checks.

## Backend API

- Money is represented as integer minor units with an explicit currency code.
- Mutating endpoints are idempotent via client-supplied idempotency keys.
- Stale or invalid mutations are rejected with a typed error and produce no
  partial financial side effects.

## Compatibility and migration

Low-bandwidth rendering is a frontend-only concern and introduces no public
API, event, or persistence schema changes. No migration is required. Clients
that do not support connection hints simply operate in `normal` state.

## Validation

Focused automated coverage exercises the successful path plus boundary,
retry/idempotency, access-control, and dependency-failure cases for the core
journeys, including constrained and offline rendering states.
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
