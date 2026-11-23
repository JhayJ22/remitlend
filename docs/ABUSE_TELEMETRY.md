# Privacy-Safe Abuse Telemetry for Financial Mutations (#852)

## Purpose and non-goals

This component records a bounded, non-identifying signal about financial
mutation attempts so operators can detect abuse (burst activity, repeated
blocked attempts) and prove that blocked requests never reach business logic.

It is **not** an accounting, scoring, or identity system. It never:

- receives or stores a wallet address, secret key, signed transaction, or XDR;
- stores an IP address, email, user agent, request body, or any free text;
- stores a monetary amount, currency, or money-unit conversion;
- feeds loan approval, repayment, scoring, balances, or settlement.

The Stellar ledger and the existing authoritative tables (`contract_events`,
`loan_events`, `transaction_submissions`, `remittances`, `scores`) remain the
only sources of truth for financial state. `abuse_telemetry_events` is an
append-only observation log with no write path into those tables.

## Supported states

All values are closed enums enforced by the Zod contract
(`backend/src/schemas/abuseTelemetrySchemas.ts`) and by database `CHECK`
constraints.

| Field          | Allowed values                                                                                                                                                                                 | Meaning                                                        |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `decision`     | `allow`, `block`                                                                                                                                                                               | Guard decision taken before the mutation handler runs          |
| `outcome`      | `success`, `failure`, `blocked`                                                                                                                                                                | Observed HTTP result: `<400`, `>=400`, or stopped by the guard |
| `riskTier`     | `low`, `medium`, `high`                                                                                                                                                                        | Coarse tier derived only from the rate band                    |
| `rateBand`     | `one`, `few`, `many`, `burst`                                                                                                                                                                  | 1; 2–5; 6–20; 21+ attempts in the fixed 60 s window            |
| `mutationType` | `loan_request`, `loan_repay`, `loan_submit`, `loan_deposit_collateral`, `loan_release_collateral`, `loan_refinance`, `loan_extend`, `loan_liquidate`, `remittance_create`, `remittance_submit` | Route-level operation key                                      |

Risk tier is `low` for `one`/`few`, `medium` for `many`, and `high` for
`burst`. A `block` occurs only when the attempt count exceeds the configured
threshold (default 20, `ABUSE_TELEMETRY_BLOCK_THRESHOLD`), so the 21st attempt
in a window is the first blocked one. The guard is installed after
authentication and body validation and before every guarded handler.

## Actor reference and privacy

The guard reads only `req.user.publicKey` from the verified JWT. It immediately
converts it to `actor_hash = sha256(pepper + UTC date + publicKey)` and never
passes the public key to the service, the database, the API response, or logs.
The pepper comes from `ABUSE_TELEMETRY_PEPPER`; if it is absent the process
generates an ephemeral pepper (production deployments must configure it or
daily references will not correlate across restarts). The UTC date suffix gives
daily rotation, limiting long-term linkage. Redis counter keys use only the
first 24 hex characters of the hash plus the mutation key.

The admin report deliberately omits `actorHash` and `eventId`. Raw hashes are
available only to security staff with direct database access.

## Input constraints and stale actions

- Query filters are validated with `abuseTelemetryQuerySchema`; unknown values
  are rejected with HTTP 400 and `limit` is clamped to 1–100 (default 50).
- `attemptsInWindow` is bounded to 1–10000 in the contract and in the DB.
- Insertion uses `INSERT ... ON CONFLICT (event_id) DO NOTHING`, so a retried
  observation cannot create a duplicate row.
- A request carrying `X-Idempotent-Replayed: true` is a cached replay of an
  already-answered operation. The guard does not increment the rate counter
  and does not execute a second mutation.
- The 60 s counter window is keyed by a time bucket and carries its own TTL;
  stale counters expire rather than blocking future windows.

## Authorization, consent, and user-visible assumptions

- Every guarded endpoint already requires `requireJwtAuth` plus the relevant
  `write:*` scope and wallet/loan ownership checks. The guard adds no new
  authority to bypass.
- The admin report requires a JWT with the `admin` role
  (`requireJwtAuth`, `requireRoles('admin')`). No API-key scope was widened.
- Users see `AbuseTelemetryNotice` in the loan signature step. It states that
  coarse action frequency and outcome are recorded, that wallet address, keys,
  signed transactions, IP, amounts, and free text are not stored, the 30-day
  retention, admin-only access, and that telemetry never affects balances,
  loan terms, or score.

## Failure behaviour

| Condition                                           | Behaviour                                                                                                  | Financial side effect                                |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Invalid/expired JWT, wrong scope, failed validation | Rejected upstream by auth/validation; guard never runs                                                     | None                                                 |
| Attempt count above threshold                       | Guard records `blocked` and returns HTTP 429 `RATE_LIMIT_EXCEEDED` before calling the handler              | **None**                                             |
| Redis/counter unavailable                           | `dependencyError: true`, decision fails open to `allow`, counter reads as 1; the outcome is still recorded | Mutation proceeds; documented availability trade-off |
| Telemetry DB insert fails                           | `record()` logs a warning and returns `false`; it never throws into the request                            | Mutation result unchanged                            |
| Downstream handler returns 4xx/5xx                  | `outcome: failure` recorded on `res.finish`                                                                | Existing handler semantics only                      |

No telemetry path opens a transaction, issues an `INSERT`/`UPDATE` against a
financial table, or calls Soroban.

## Retention and access controls

- Events carry `expires_at = occurred_at + retentionDays` (default 30,
  `ABUSE_TELEMETRY_RETENTION_DAYS`).
- `startAbuseTelemetryRetentionScheduler()` runs an immediate purge and then a
  daily sweep (`ABUSE_TELEMETRY_PURGE_INTERVAL_MS`), deleting only rows whose
  `expires_at <= NOW()`. It is stopped during graceful shutdown.
- Read access: `GET /api/v1/admin/abuse-telemetry` (and the deprecated
  `/api/admin/abuse-telemetry` alias) with admin JWT. The response is aggregate
  counts plus coarse event fields; it contains no actor hash.
- Write access to the table is limited to the telemetry service inside the API
  process. There is no public or user-level write endpoint.

## API contract and migration implications

The change is additive:

- New table `abuse_telemetry_events` with four indexes; no existing table,
  column, enum, or row is altered. Migration:
  `backend/migrations/1811000000000_abuse-telemetry-events.js`.
- New optional query parameters on a new admin route; no existing response
  shape changed, so old clients are unaffected. The legacy `/api/admin/*` alias
  is mounted for parity with other admin endpoints.
- Rolling back removes only the new table and route; no data migration is
  needed and no financial state depends on the table.

## Validation evidence

From the repository root:

```sh
cd backend
npm test -- --runTestsByPath src/services/__tests__/abuseTelemetryService.test.ts src/__tests__/abuseTelemetryGuard.test.ts
npm run typecheck
cd ../frontend
npm test -- --runTestsByPath src/app/components/security/__tests__/AbuseTelemetryNotice.test.tsx
npm run typecheck
```

Coverage includes derivation boundaries, the 20/21 attempt threshold, idempotent
replays, dependency failure, best-effort persistence, retention purge, admin
report redaction, and an Express-level assertion that a blocked request never
calls the financial mutation handler.
