# Protocol Parameter Governance

This document describes the governance process for changing protocol risk
parameters (interest rate models, liquidation thresholds, collateral factors,
and related risk knobs).

## Overview

Risk parameters can no longer be changed directly by the admin. Every change
must go through an on-chain governance flow with a timelock:

1. **Propose** — an admin submits a proposal describing the target parameter
   and its proposed value. The backend records the proposal in the database and
   submits a `propose_risk_change` transaction to the contract.
2. **Wait** — the contract enforces a timelock. The proposal cannot be executed
   until the timelock has elapsed.
3. **Execute** — after the timelock, an admin submits `execute_risk_change` to
   apply the change on-chain.

Proposals move through the following statuses:

| Status              | Meaning                                                        |
| ------------------- | -------------------------------------------------------------- |
| `proposed`          | Proposal recorded and `propose_risk_change` submitted on-chain |
| `pending_execution` | Timelock has elapsed; ready to be executed                     |
| `executed`          | `execute_risk_change` submitted and applied on-chain           |
| `cancelled`         | Proposal cancelled before execution                            |

## API Reference

All endpoints are admin-only and live under `/admin/governance`.

### `POST /admin/governance/proposals`

Create a governance proposal for a risk parameter change. Persists the proposal
in the database and submits a `propose_risk_change` transaction to the contract.

Request body:

```json
{
  "parameter": "liquidation_threshold",
  "value": "0.85"
}
```

Response (`201 Created`):

```json
{
  "id": "prop_01H...",
  "parameter": "liquidation_threshold",
  "value": "0.85",
  "status": "proposed",
  "submitter": "GADMIN...",
  "txHash": "abc123...",
  "createdAt": "2024-01-01T00:00:00.000Z",
  "executableAt": "2024-01-02T00:00:00.000Z"
}
```

Each proposal records the submitter, the target parameter, the proposed value,
and the on-chain transaction hash.

### `GET /admin/governance/proposals`

List all governance proposals with their current status (`proposed`,
`pending_execution`, `executed`, `cancelled`).

Response (`200 OK`):

```json
{
  "proposals": [
    {
      "id": "prop_01H...",
      "parameter": "liquidation_threshold",
      "value": "0.85",
      "status": "pending_execution",
      "submitter": "GADMIN...",
      "txHash": "abc123...",
      "createdAt": "2024-01-01T00:00:00.000Z",
      "executableAt": "2024-01-02T00:00:00.000Z"
    }
  ]
}
```

### `POST /admin/governance/proposals/:id/execute`

Submit `execute_risk_change` to the contract. Execution is rejected with
`409 Conflict` if the timelock has not yet elapsed.

Response (`200 OK`):

```json
{
  "id": "prop_01H...",
  "status": "executed",
  "txHash": "def456..."
}
```

## Timelock Enforcement

The timelock is enforced on-chain by the contract. The backend additionally
checks `executableAt` before submitting `execute_risk_change` so that premature
execution attempts fail fast with a clear error instead of a failed transaction.
