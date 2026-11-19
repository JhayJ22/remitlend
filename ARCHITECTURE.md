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
