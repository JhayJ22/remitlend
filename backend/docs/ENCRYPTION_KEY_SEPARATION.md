# Field-Level Encryption Key Separation by Data Classification

> Issue #846 — classify sensitive fields, separate key domains and access
> roles, and prove that rotation or revocation in one class does not decrypt
> unrelated data or break required audit records.

## Overview

Sensitive data is encrypted at the field level with AES-256-GCM envelope
encryption: each field value is encrypted with a fresh Data Encryption Key
(DEK), and the DEK is wrapped by a Key Encryption Key (KEK). The KEK is the
long-lived secret; the DEK is single-use and stored wrapped alongside the
ciphertext.

Before #846 the whole system used **one global KEK** (`PII_KEK_ID`) for every
encrypted field. This means a single key compromise, rotation, or revocation
affected every data class at once. #846 introduces **key-domain separation by
data classification**: sensitive fields are classified, each class gets its own
independent KEK domain, decryption authority is split per class, and
rotation/revocation are scoped to a single class.

## Data classes

| Class        | What it protects                                   | Examples                                    |
|--------------|----------------------------------------------------|---------------------------------------------|
| `pii`        | Personal identifiable information                  | `user_profiles.email`, `user_profiles.phone`|
| `financial`  | Transaction / financial material                   | `remittances.xdr`, `transaction_submissions.result_xdr` |
| `credential` | Signing secrets / credentials                      | `webhook_secrets.secret`                    |
| `audit`      | Audit records (integrity evidence)                 | `audit_logs.payload`, `pii_access_log.*`     |

The authoritative mapping lives in `FIELD_CLASSIFICATION` in
`services/encryptionKeyDomains.ts`. Unknown fields are conservatively treated
as `pii` and a warning is logged so the registry is kept deliberate.

**Why `audit` is its own class.** Audit evidence must remain readable through
*any* other class's rotation or revocation. `pii_access_log` (the decryption
audit trail) is append-only plaintext, and the audit KEK lives in its own
domain, so revoking the PII/financial/credential KEK can never render audit
records unreadable. Encrypting audit records would require an audit KEK that is
never rotated by a non-audit rotation; this design preserves that invariant.

## Key-domain separation

Each class resolves its own KEK from class-scoped environment variables:

| Env var               | Class        |
|-----------------------|--------------|
| `PII_KEK_ID` / `PII_KEK_KEY`         | `pii`        |
| `FINANCIAL_KEK_ID` / `FINANCIAL_KEK_KEY`   | `financial`   |
| `CREDENTIAL_KEK_ID` / `CREDENTIAL_KEK_KEY` | `credential`  |
| `AUDIT_KEK_ID` / `AUDIT_KEK_KEY`          | `audit`       |
| `PII_KMS_ENDPOINT`   | shared KMS endpoint (KMS scopes keys by `kek_id`) |

`*_KEK_ID` is the logical identifier recorded per row (`dek_kek_id`); `*_KEK_KEY`
is the 32-byte key material in hex (local mode only — in KMS mode the material
never leaves the KMS).

**Backward compatibility (single-KEK deployments).** A class whose env var is
unset falls back to the legacy `PII_KEK_*` values, and ultimately to the
pre-#846 defaults (`default-kek` id, all-zeros key). This means a deployment
that only configured `PII_KEK_ID`/`PII_KEK_KEY` keeps a single shared KEK across
all classes and **no existing ciphertext becomes unreadable**. Setting the
per-class vars is what *separates* the domains: a DEK wrapped by one class's
KEK cannot be unwrapped by another class's KEK (proven by
`piiCryptoClassification.test.ts`).

## Access roles

Decryption authority is granted per class to a distinct principal, so no single
principal can decrypt every class:

| Principal                | Classes it may decrypt |
|--------------------------|------------------------|
| `admin`                  | `pii`, `audit`         |
| `support`                | `pii`                  |
| `transaction-processor`   | `financial`            |
| `credential-rotator`     | `credential`          |
| `auditor`                | `audit`                |
| `system` / `borrower` / `lender` / `anonymous` | none |

Enforce with `assertCanDecrypt(principal, dataClass)` (throws
`KeyAccessDeniedError`). `financial`, `credential`, and `audit` are mutually
exclusive to three different internal roles — the access-separation guarantee.

## Rotation (class-scoped)

`KeyRotationService.startRotation(newKekId, actor, requestId, dataClass)`
rotates **only** the DEKs of `dataClass` whose `dek_kek_id` equals the class's
current KEK id. The scan predicate is
`WHERE data_class = $1 AND dek_kek_id = $2`, so DEKs (and ciphertext) of any
other class are never read or written by the batch.

**Supported states** (`key_rotation_batch.status`):
`pending → in_progress → completed | failed | rolled_back`.

Properties:
- **Authorization**: rotation to a revoked KEK is rejected up front
  (`KeyRevokedError`); only one in-progress batch per class is allowed
  (`RotationAlreadyInProgressError`); a no-op rotation (new == current) is
  rejected (`NOOP_ROTATION`).
- **Idempotency / resumable**: batches are processed in fixed-size pages with a
  `last_rotated_record_id` checkpoint; `resumeRotation(batchId)` continues from
  the checkpoint. Re-running cleanup over an already-completed/rolled-back
  batch is rejected, never a double transition.
- **Retry**: transient KMS failures retry with exponential backoff
  (`KMSUnwrapError`/`KMSWrapError` marked retryable); permanent errors
  (`DecryptionError`, auth-tag mismatch) fail immediately.
- **Verification**: `verifyRotation(batchId)` GCM-decrypts a random sample of
  rotated records with the new KEK; a passing auth-tag check proves the new
  wrapped DEK still decrypts the stored ciphertext.
- **Rollback**: `rollbackRotation` restores each record's recorded
  `old_dek_wrapped` and old `dek_kek_id` (the checkpoint stores both wrappings),
  so a failed rotation is fully reversible without re-deriving keys.

**Class isolation guarantee:** rotating the PII KEK never re-wraps financial,
credential, or audit DEKs; their ciphertext and `dek_kek_id` are untouched.

## Revocation (fail-closed, class-scoped)

`revokeKek(kekId, { dataClass, actor, reason, requestId })` records the KEK id in
an in-memory set and the durable `kek_revocations` table. The in-memory
revocation takes effect even if the DB write fails, so the fail-closed property
holds within the process; `loadRevocations()` reseeds the set on startup.

- **Encrypt path**: `encryptField`/`wrapDek` refuse to wrap under a revoked KEK
  (`KeyRevokedError`) — no new ciphertext is written under a revoked key.
- **Decrypt path**: `decryptField`/`unwrapDek` refuse to unwrap a revoked KEK
  (`KeyRevokedError`) **before** returning the DEK. The denial is still written
  to `pii_access_log` (audit the denial), so access attempts under a revoked key
  are auditable.
- **Class scoping**: revoking the PII KEK only blocks PII decrypt; financial,
  credential, and audit ciphertext remain fully decryptable with their own KEKs.
  Because audit records live in the `audit` class with its own KEK and the
  plaintext `pii_access_log` is never encrypted, **revocation never breaks
  required audit records**.

## API surface

`POST /admin/key-rotation/start` accepts `new_kek_id` and an optional
`data_class` (one of `pii` | `financial` | `credential` | `audit`, default
`pii`); the response echoes the resolved `data_class`. The remaining rotation
endpoints (`/batch/:batchId`, `.../verify`, `.../complete`, `.../rollback`,
`.../resume`, `/batches`) are unchanged in shape. Authorization is
`admin:all` only.

## Compatibility & migration

- **Migration `1809000000001_encryption-key-separation`** is additive: it adds
  `data_class` (default `pii`, with a `CHECK` constraint) to `pii_encrypted_fields`
  and `key_rotation_batch`, adds class-scoped indexes, and creates
  `kek_revocations` (unique `kek_id` for idempotent revocation). No existing
  column is renamed, removed, or re-typed; no existing row becomes unreadable.
- **Backward-compatible defaults**: unset per-class KEK env vars fall back to
  the legacy `PII_KEK_*` values, so deployments that have not configured
  per-class keys keep working unchanged (single shared KEK).
- **Rollout**: deploy the migration → (optional) set per-class KEK env vars →
  existing and new ciphertext classify correctly. To separate a class, set its
  `*_KEK_ID`/`*_KEK_KEY` to distinct material; new writes for that class use the
  new KEK, and a class-scoped rotation re-wraps existing rows of that class.
- **Rollback**: the migration `down` drops the added table/columns/indexes.
  Revocation rows and rotation-batch metadata are the only data removed; no
  ciphertext is touched.

## Validation evidence

Reproducible, automated coverage (run from `backend/`):

```bash
# Classification, per-class KEK resolution, access roles, revocation (fail-closed + DB-failure)
npm test -- --runTestsByPath src/services/__tests__/encryptionKeyDomains.test.ts

# Per-class round-trip, cross-class isolation, backward-compat single KEK, revocation fails closed for one class only
npm test -- --runTestsByPath src/services/__tests__/piiCryptoClassification.test.ts

# Class-scoped rotation, retry/backoff, verification, real rollback, resume, concurrency
npm test -- --runTestsByPath src/services/__tests__/keyRotationService.test.ts
```

What each suite proves against the issue's acceptance criteria:
- **Successful path**: round-trip encrypt/decrypt per class; class-scoped
  rotation completes; verification passes.
- **Boundary**: noop rotation, empty/short values, corrupted wrapped DEK
  (`DecryptionError`), revoked-KEK rejection, max-retry exhaustion.
- **Retry / idempotency**: transient KMS retry with backoff; resumable
  checkpoints; no double state transitions.
- **Access control**: per-class `canDecryptClass`/`assertCanDecrypt`;
  financial/credential/audit mutually exclusive to different principals.
- **Dependency failure**: revocation persists in-memory even when the DB write
  fails (fail-closed in-process); KMS unreachable → typed `KMS*Error`.

End-to-end (requires a migrated Postgres; opt-in, skipped in CI):

```bash
INTEGRATION_TESTS=true DATABASE_URL=postgres://... npm test -- \
  --runTestsByPath src/__tests__/integration/keyRotation.integration.test.ts
```
