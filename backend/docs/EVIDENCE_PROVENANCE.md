# Signed Evidence Provenance for Externally Supplied Records

> Issue #848 — security: add signed evidence provenance for externally supplied records

## Overview

Every externally supplied record that feeds into a financial decision is bound
to an immutable, HMAC-signed provenance row. The row records:

- **Evidence digest** — SHA-256 over the canonical JSON of the external record
- **Source identity** — where the record came from (contract ID, RPC endpoint hash, webhook subscriber)
- **Ingestion time** — system timestamp when the record was processed
- **Verification result** — `verified`, `provisional`, `rejected`, or `quarantined`
- **Row HMAC** — HMAC-SHA256 over all row columns, keyed with `INTERNAL_SIGNING_SECRET`

The original payload is **never** stored in the provenance table. Only the
digest and structured metadata survive, so the table is safe for audit logs,
public dashboards, and regulatory review without leaking sensitive data.

---

## Architecture

| Layer | Location | Responsibility |
|---|---|---|
| Database | `evidence_provenance` table | Append-only, immutability trigger blocks UPDATE/DELETE |
| Service | `backend/src/services/evidenceProvenanceService.ts` | Digest computation, HMAC signing, validation, query API |
| Controller | `backend/src/controllers/evidenceProvenanceController.ts` | HTTP layer (admin read-only) |
| Routes | `backend/src/routes/adminRoutes.ts` | `/admin/evidence-provenance/*` endpoints |
| Integration | `backend/src/services/eventIndexer.ts` | Calls `recordEvidence` for every indexed and quarantined event |

---

## Database schema

### `evidence_provenance` (append-only)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | `gen_random_uuid()` |
| `record_type` | varchar(64) | Bounded by CHECK constraint |
| `record_ref` | varchar(255) | External ID (event_id, tx_hash, delivery_id) |
| `source_identity` | varchar(255) | Source (contract:C..., rpc:hash, webhook:sub_id) |
| `evidence_digest` | varchar(64) | SHA-256 hex — the only content-derived column |
| `digest_algorithm` | varchar(16) | Always `sha256` |
| `ingested_at` | timestamp | System time of ingestion |
| `verification_result` | varchar(32) | `verified` / `provisional` / `rejected` / `quarantined` |
| `verification_detail` | jsonb | Structured metadata — never the raw payload |
| `signing_key_id` | varchar(128) | Which key produced the HMAC |
| `row_hmac` | varchar(64) | HMAC-SHA256 over pipe-joined row columns |

**Unique constraint**: `(record_type, record_ref, evidence_digest)` — the same
record from the same source with the same content produces exactly one row.

**Immutability trigger**: blocks all `UPDATE` and `DELETE`.

---

## HMAC row binding

The `row_hmac` is computed as:

```
message = `${id}|${record_type}|${record_ref}|${source_identity}|${evidence_digest}|${ingested_at_iso}|${verification_result}`
row_hmac = HMAC-SHA256(message, INTERNAL_SIGNING_SECRET)
```

This binds every column of the row at insert time. Any post-insert tampering
(e.g. changing the verification result) can be detected by re-computing the
HMAC and comparing — use the `GET /admin/evidence-provenance/:id/verify`
endpoint or the `verifyRowHmac()` / `verifyEvidence()` service functions.

The signing key is the same `INTERNAL_SIGNING_SECRET` env var used by the
internal request signing middleware. The `signing_key_id` column records which
key version produced the HMAC, enabling verification against a rotated key.

---

## Supported record types

| `record_type` | Description | Integration point |
|---|---|---|
| `indexer_event` | Soroban on-chain event parsed by the indexer | `eventIndexer.storeEvents()` — after commit, for each inserted event |
| `quarantine_event` | Malformed event sent to quarantine | `eventIndexer.quarantineEvent()` — after INSERT |
| `remittance_ingestion` | Remittance record from external source | (future — `remittanceService.createRemittance()`) |
| `reconciliation_check` | Discrepancy detected by cross-system reconciliation | (future — `discrepancyLedgerService.recordDiscrepancy()`) |
| `webhook_delivery` | Inbound webhook delivery from a subscriber | (future — webhook verification middleware) |

Adding a new record type requires:
1. Extending the `CHECK` constraint in a new migration.
2. Adding the type to `EVIDENCE_RECORD_TYPES` in `evidenceProvenanceService.ts`.
3. Calling `recordEvidence()` from the ingestion point.

---

## API endpoints (admin, read-only)

Write operations are **internal-only** — there is no public POST endpoint.
This prevents injecting fabricated evidence from outside the trust boundary.
Only ingestion jobs running inside the backend process can create evidence rows.

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/admin/evidence-provenance/meta` | JWT admin | Supported types and results |
| `GET` | `/admin/evidence-provenance` | JWT admin | List (filterable, keyset-paginated) |
| `GET` | `/admin/evidence-provenance/:id` | JWT admin | Fetch single record |
| `GET` | `/admin/evidence-provenance/:id/verify` | JWT admin | Re-verify HMAC integrity |

---

## Disclosure guarantee

The `evidence_provenance` table stores **only**:
- A SHA-256 digest of the external record (one-way, irreversible)
- Structured metadata in `verification_detail` (ledger, txHash, contractId, errorCode — never raw payloads)
- The HMAC signature

The original record content (borrower addresses, amounts, private keys, XDR
payloads) is never persisted in this table. The test suite includes a
disclosure-guarantee test that verifies the INSERT SQL parameters never
contain sensitive plaintext from the input record.

---

## Idempotency

A duplicate `(record_type, record_ref, evidence_digest)` returns the existing
row instead of failing. The Postgres unique constraint (code 23505) is caught and
the existing row is fetched and returned. This means re-running the indexer over
the same ledger range does not create duplicate evidence rows.

---

## Migration

File: `backend/migrations/1811000000000_evidence-provenance.js`

```bash
npm run db:migrate
```

Fully reversible via `down` (drops table, trigger, function).

---

## Testing

```bash
cd backend
npm test -- --testPathPattern=evidenceProvenanceService
```

Covers: canonicalize determinism, digest sensitivity, HMAC column sensitivity
(changes when any of 7 inputs change), `verifyRowHmac` true/false cases,
`recordEvidence` happy path + idempotency + 5 validation guards + DB error
propagation, `getEvidence` found/404, `findEvidence` most-recent, `listEvidence`
filters+cursor+limit-cap, `verifyEvidence` round-trip, and a disclosure-guarantee
test confirming no raw payload appears in INSERT parameters.
