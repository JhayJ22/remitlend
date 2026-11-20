# Staged Secret Rotation Verification

**Issue:** #851  
**Status:** Implemented  
**Affects:** Database credentials, JWT signing, internal request signing, webhook secrets, PII encryption keys, Soroban signing keys, and all background workers  

---

## Overview

This document defines the staged rotation contract for every credential type in the RemitLend system. The goal is to verify that secret rotation across live replicas and background workers proceeds through a well-defined lifecycle — overlap, propagation, revocation, and recovery — without logging secret material.

---

## Supported Credential Types

| Type | Env var / Source | Read pattern | Live-rotatable without restart? |
|---|---|---|---|
| `database` | `DATABASE_URL` | Cached in `Pool` at construction | No — requires pool recreation |
| `jwt_signing` | `JWT_SECRET` | Re-read per call (`getJwtSecret`) | Yes (in-process env mutation) |
| `internal_signing` | `INTERNAL_SIGNING_SECRET` | Dual-secret overlap window (new) | Yes — overlap window accepts both |
| `webhook_inbound` | `webhook_secrets` table | DB query per call | Yes — DB-driven, live across all replicas |
| `webhook_egress` | `webhook_subscriptions.secret` | DB query per event/retry | Yes — picked up next cycle |
| `pii_encryption` | `PII_KEK_ID` / `PII_KEK_KEY` | KEK_ID cached at load; KEK_KEY re-read per wrap | Partially — KEK rotation via `KeyRotationService` |
| `soroban_signing` | External signer `authToken` | Captured at signer construction | No — external signer config rollout |

---

## Rotation Lifecycle

```
staged → overlap → propagating → revoking → completed
                                      ↘ recovering → rolled_back
```

### Stages

| Stage | Description | Pre-condition |
|---|---|---|
| `staged` | New credential prepared; old credential still sole active | No in-progress rotation for same type+subject |
| `overlap` | Both old and new credentials accepted simultaneously | New credential is reachable |
| `propagating` | Verify all replicas/workers have observed the new credential | Overlap window active |
| `revoking` | Old credential deactivated; only new is accepted | All propagation targets confirmed |
| `completed` | Rotation finished; old credential may be destroyed | Revocation confirmed |
| `failed` | A stage could not complete | Any stage failure |
| `recovering` | Rolling back to pre-rotation state | Rotation is in `failed` |
| `rolled_back` | Old credential restored as sole active | Recovery complete |

### Valid Transitions

```
staged       → overlap, failed
overlap      → propagating, recovering, failed
propagating  → revoking, recovering, failed
revoking     → completed, recovering, failed
failed       → recovering
recovering   → rolled_back, failed
completed    → (terminal)
rolled_back  → (terminal)
```

Invalid transitions are rejected with `InvalidStageTransitionError` before any database write.

---

## Overlap Mechanism

### Internal Signing Secret (dual-secret window)

The `internalRequestSigning.ts` middleware now supports a dual-secret overlap window:

1. **`beginSigningSecretOverlap(newSecret, oldSecret)`** — Sets both secrets as active. `verifyRequestSignature` accepts requests signed with either. `signRequest` signs with the new secret.
2. During the overlap window, `getActiveSigningSecrets()` returns `[newSecret, oldSecret]`.
3. **`revokeOldSigningSecret()`** — Clears the old secret. Only the new secret is accepted.
4. After revocation, `getActiveSigningSecrets()` returns `[newSecret]`.

This enables zero-downtime rotation: in-flight requests signed with the old secret continue to verify, while new requests are signed with the new secret.

### Webhook Inbound Secrets (DB-backed)

Webhook secrets are DB-backed and queried per call via `getActiveSecret(subscriberId)`. Rotation via `rotateSubscriberSecret(subscriberId)` inserts a new active row and deactivates the old one. All replicas and workers that read from the same DB immediately observe the new secret — no process restart needed.

### PII Encryption Keys

The existing `KeyRotationService` handles PII KEK rotation with batch processing, checkpointing, verification, and rollback. Each encrypted record stores its own `dek_kek_id`, enabling read-through across coexisting KEK versions during the rotation window.

---

## Propagation Verification

Each rotation declares a set of **propagation targets** — the consumers that must observe the new credential before the old one is revoked:

| Credential Type | Default Propagation Targets |
|---|---|
| `database` | `api-process`, `event-indexer`, `webhook-retry-worker`, `score-reconciliation-worker` |
| `jwt_signing` | `api-process` |
| `internal_signing` | `api-process`, `internal-caller` |
| `webhook_inbound` | `webhook-receiver`, `webhook-retry-worker` |
| `webhook_egress` | `webhook-dispatcher`, `webhook-retry-worker` |
| `pii_encryption` | `api-process`, `pii-rotation-worker` |
| `soroban_signing` | `soroban-submitter`, `external-signer` |

`confirmPropagationTarget(rotationId, targetName)` marks a target as confirmed. `isPropagationComplete(state)` returns true only when all targets are confirmed. The revocation stage should not be advanced until propagation is complete.

A SHA-256 hash of the new secret is stored in `credential_rotation_events.new_secret_hash` so consumers can verify they are using the correct credential without the secret itself being stored.

---

## Revocation and Recovery

### Revocation

After all propagation targets confirm, advance to the `revoking` stage. This deactivates the old credential:
- **Internal signing**: `revokeOldSigningSecret()` clears the previous secret from the in-process registry.
- **Webhook inbound**: `rotateSubscriberSecret` already deactivated the old row.
- **PII encryption**: The old KEK may be decommissioned in the external KMS after `KeyRotationService` marks the batch complete.

### Recovery

If propagation fails or verification detects an inconsistency, the rotation moves to `failed` then `recovering` then `rolled_back`:
- **Internal signing**: Re-instate the old secret as the sole active one.
- **Webhook inbound**: The old secret row was deactivated but not deleted; reactivating it (or issuing a new rotation back to the old value) restores service.
- **PII encryption**: `KeyRotationService.rollbackRotation` reverts all rotated records.

`recoverRotation(rotationId, actor, reason)` handles the full recovery transition in one call.

---

## Audit Logging

Every stage transition writes an entry to `audit_logs` with:
- `actor`: The admin who initiated or advanced the stage
- `action`: `CREDENTIAL_ROTATION_STAGED`, `CREDENTIAL_ROTATION_OVERLAP`, `CREDENTIAL_ROTATION_PROPAGATING`, `CREDENTIAL_ROTATION_REVOKING`, `CREDENTIAL_ROTATION_COMPLETED`, `CREDENTIAL_ROTATION_RECOVERING`, `CREDENTIAL_ROTATION_ROLLED_BACK`
- `target`: `Credential:{type}:{subject}`
- `payload`: Sanitized metadata (secret values are `[REDACTED]`)

Additionally, each stage event is recorded in the `credential_rotation_events` table with:
- `credential_type`, `subject`, `stage`, `previous_stage`
- `actor`, `outcome` (success/partial/failed)
- `metadata` (sanitized — keys matching `secret|password|token|key|credential|private` are replaced with `[REDACTED]`)
- `new_secret_hash` (SHA-256 — one-way, cannot recover the secret)

**No secret material is ever stored in the database or logs.** The `sanitizeMetadata` function strips any key whose name matches sensitive patterns, and any string value longer than 128 characters is truncated.

---

## Input Constraints

| Constraint | Rule |
|---|---|
| `credentialType` | Must be one of the 7 defined types (DB CHECK constraint) |
| `stage` | Must be one of the 8 defined stages (DB CHECK constraint) |
| `outcome` | Must be `success`, `partial`, or `failed` (DB CHECK constraint) |
| Double rotation | Rejected if a rotation for the same type+subject is in progress |
| Invalid transition | Rejected before any DB write |

---

## Failure Behavior

| Failure | Behavior |
|---|---|
| DB unreachable during rotation | `startRotation` throws; `advanceStage` audit log write is swallowed (logged, not thrown); rotation stage record may fail |
| Audit log INSERT fails | Error is logged; rotation continues (audit is best-effort) |
| Propagation target never confirms | Rotation stays in `propagating`; operator may advance to `failed` then `recovering` |
| Old secret rejected after revocation | By design — the old credential is no longer valid |
| Recovery from completed state | Rejected with `InvalidStageTransitionError` |

---

## Migration

**`1810000000000_credential-rotation-events.js`** creates the `credential_rotation_events` table with CHECK constraints on `credential_type`, `stage`, and `outcome`. Additive only — no existing schema is altered.

---

## Validation Evidence

Run the following to reproduce all test cases:

```bash
# Backend staged rotation tests
cd backend && npm test -- --testPathPattern="stagedRotation"
```

Expected: all tests pass. The test suite covers:
- Full lifecycle (staged → completed) for each credential type
- Overlap window: both old and new internal signing secrets accepted
- Propagation: all targets confirmed before revocation
- Revocation: old secret rejected after revocation
- Recovery: rollback from failed to rolled_back
- Boundary: invalid transition, double rotation, unknown rotation ID
- Idempotency: re-calling begin/revoke overlap
- Dependency failure: DB unreachable, audit log write failure
- Secret material never stored: sanitized metadata assertions, no raw secret in audit entries
