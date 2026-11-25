# Cryptographic Erasure Verification for Deleted User Data

> Issue #847 — define how encrypted data and key material are removed across
> primary storage, replicas, backups, and exports; add a verifiable deletion
> report with explicit retention exceptions.

## Overview

RemitLend encrypts personally identifiable information (PII) with per-field
Data Encryption Keys (DEKs) wrapped by a Key Encryption Key (KEK). The
cryptographic erasure workflow proves data deletion by:

1. **Nulling PII columns** in the primary database (email, phone, display_name).
2. **Zeroing wrapped DEKs** in `pii_encrypted_fields` — any ciphertext that
   survives in cold storage becomes permanently unrecoverable without the DEK.
3. **Revoking the user's per-user KEK id** in `kek_revocations` — any in-memory
   decrypt attempt is rejected fail-closed from that point forward.
4. **Issuing a SHA-256-committed certificate** — a tamper-evident record of
   exactly what was erased, what was retained, why, and when.

## Erasure lifecycle states

```
(request submitted) → pending
                     → in_progress  (admin executes)
                     → completed    (certificate issued)
                     → failed       (retryable)
                     → rejected     (active loan / duplicate)
```

## Storage tiers

| Tier | How erased | When |
|------|-----------|------|
| **Primary DB** | PII columns NULLed; DEKs zeroed | At execution time |
| **Replicas** | Expire naturally as replication slots advance | Within minutes of primary execution |
| **Backups** | Excluded from next scheduled backup rotation | Within `BACKUP_RETENTION_DAYS` (default 30 days) |
| **Exports / diagnostic bundles** | TTL-expired and purged (see `DIAGNOSTIC_BUNDLE_TTL_HOURS`) | Automatically on next cleanup cycle |

The certificate documents `storage_tiers.replicas`, `backups`, and `exports` as
`null` (not yet completed at certificate issuance) with this policy documented
in `retention_basis`. Operators must mark those tiers complete when backup
rotation or export purge occurs.

## Retention exceptions

The following records are retained despite an erasure request and explicitly
listed in every certificate:

| Table | Fields | Reason |
|-------|--------|--------|
| `audit_logs` | `*` | AML/CFT financial record-keeping obligation (minimum 5 years) |
| `pii_access_log` | `*` | Security audit trail required for incident investigation |
| `loan_events` | `borrower` (Stellar public key) | On-chain pseudonymous identifier; part of immutable ledger history |

Stellar public keys are **pseudonymous on-chain identifiers**, not plaintext
PII. They are retained as part of the immutable ledger record and cannot be
removed without invalidating on-chain proofs.

## Authorization

| Operation | Required role |
|-----------|--------------|
| Self-request (`POST /user/erasure-request`) | Authenticated user (JWT) |
| Admin initiate (`POST /admin/erasure`) | `admin` role (JWT) |
| Execute (`POST /admin/erasure/:id/execute`) | `admin` role (JWT) |
| View request / certificate | `admin` role (JWT) |

**Guards:**
- An erasure is rejected while the user has an active financial obligation
  (outstanding loan not yet repaid, defaulted, or liquidated).
- A second request is rejected while one is already `pending` or `in_progress`.
- A `completed` or `in_progress` request cannot be re-executed (idempotency).

## Certificate

The erasure certificate is a JSON document with a SHA-256 commitment over its
fields. Any post-issuance modification of `fields_erased`, `fields_retained`,
`storage_tiers`, `issued_at`, or `issued_by` changes the hash and is detectable
by re-computation.

```json
{
  "id": "<uuid>",
  "erasure_request_id": "<uuid>",
  "certificate_hash": "<64 hex chars>",
  "fields_erased": [
    { "table": "user_profiles", "field": "email", "record_count": 1 },
    { "table": "user_profiles", "field": "phone", "record_count": 1 },
    { "table": "user_profiles", "field": "display_name", "record_count": 1 },
    { "table": "user_profiles", "field": "metadata", "record_count": 1 },
    { "table": "notifications", "field": "*", "record_count": 7 },
    { "table": "pii_encrypted_fields", "field": "dek_wrapped", "record_count": 3 }
  ],
  "fields_retained": [
    { "table": "audit_logs", "field": "*", "record_count": 12,
      "reason": "AML/CFT financial record-keeping obligation (minimum 5 years)" },
    { "table": "pii_access_log", "field": "*", "record_count": 4,
      "reason": "Security audit trail required for incident investigation" },
    { "table": "loan_events", "field": "borrower", "record_count": 2,
      "reason": "On-chain event record; Stellar public key is pseudonymous" }
  ],
  "retention_basis": "Financial records subject to AML/CFT 5-year retention...",
  "kek_revocation_ref": "user:GPUBKEY...",
  "storage_tiers": {
    "primary": "2026-11-19T14:00:00.000Z",
    "replicas": null,
    "backups": null,
    "exports": null
  },
  "issued_at": "2026-11-19T14:00:01.000Z",
  "issued_by": "GADMIN...",
  "hash_verified": true
}
```

The `hash_verified` field is computed fresh on every `GET
/admin/erasure/:id/certificate` call and is never stored — it is always a live
re-verification of the stored JSON.

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/user/erasure-request` | Self-service right-to-erasure |
| `POST` | `/admin/erasure` | Admin-initiated erasure |
| `GET` | `/admin/erasure` | List requests |
| `GET` | `/admin/erasure/:id` | Single request |
| `POST` | `/admin/erasure/:id/execute` | Execute pending request |
| `GET` | `/admin/erasure/:id/certificate` | Fetch + verify certificate |

## Compatibility and migration

- Migration `1809000000003_cryptographic-erasure` is **additive** — no existing
  column is renamed, removed, or re-typed.
- `erasure_certificates` has a FK to `erasure_requests` with `ON DELETE RESTRICT`
  — certificates survive any attempt to delete the parent request.
- Rollout: deploy migration → route user deletion requests through the new API
  instead of the raw `databaseService.delete()` call.
- Rollback: `migrate down` drops both tables cleanly.

## Validation evidence

```bash
# Run the focused test suite (no database required — pool is fully mocked):
cd backend
npm test -- --runTestsByPath src/services/__tests__/erasureService.test.ts
# Expected: Tests: 22 passed
```

Covers: SHA-256 determinism + tamper detection; successful initiation + audit;
duplicate rejection; active-loan rejection; audit-failure resilience; execute
success + DEK zeroing + certificate issuance; completed re-execution rejection;
execution failure → `failed` state; kek_revocations skip (table absent);
verifyCertificateHash true/false; getRequest/getCertificate 200+404; listRequests
pagination + status filter.
