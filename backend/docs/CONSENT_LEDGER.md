# Consent Ledger — User-Visible Consent for Sensitive Data Processing

> Issue #845 — security: define a user-visible consent ledger for sensitive data processing

## Overview

The consent ledger records every processing grant and revocation a user makes,
exposing a full history to both the user and internal auditors. It enforces
those decisions in downstream jobs — no background job may process a user's
sensitive data without an active, in-policy-version consent grant.

---

## Architecture

| Layer | Location | Responsibility |
|---|---|---|
| Database | `consent_ledger` table + `consent_effective` view | Append-only history; latest-status view |
| Service | `backend/src/services/consentLedgerService.ts` | Business logic, validation, audit writes |
| Controller | `backend/src/controllers/consentController.ts` | HTTP layer, extract JWT identity & IP |
| Routes | `backend/src/routes/userRoutes.ts` | Mount under `/user/consent/*` |
| Job enforcement | `backend/src/cron/scoreDecayJob.ts` | Calls `isConsentGranted` before each user |
| Frontend hooks | `frontend/src/app/hooks/useApi.ts` | `useConsentLedger`, `useGrantConsent`, `useRevokeConsent` |
| Frontend UI | `frontend/src/app/[locale]/settings/page.tsx` | Privacy & Data tab in Settings |

---

## Database schema

### `consent_ledger` (append-only)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | `gen_random_uuid()` |
| `user_id` | varchar(255) | Stellar public key |
| `purpose` | varchar(64) | Bounded by CHECK constraint |
| `status` | varchar(16) | `granted` / `revoked` / `expired` |
| `policy_version` | varchar(16) | MAJOR.MINOR format, e.g. `"1.0"` |
| `data_categories` | jsonb | Array of category strings |
| `revocation_reason` | text | Null on grant rows |
| `idempotency_key` | varchar(255) UNIQUE | Client-supplied header |
| `ip_address` | varchar(64) | Captured at action time |
| `user_agent` | text | Captured at action time |
| `created_at` | timestamp NOT NULL | Immutable |

**Postgres trigger** `consent_ledger_guard`:
- Blocks all `UPDATE` and `DELETE`.
- Revocation = new row with `status='revoked'`, not an update to the grant row.

### `consent_effective` (view)

```sql
SELECT DISTINCT ON (user_id, purpose)
  id, user_id, purpose, status, policy_version, data_categories,
  created_at AS effective_since
FROM consent_ledger
ORDER BY user_id, purpose, created_at DESC;
```

Downstream jobs query this view, never the raw table, to get the current status.

---

## Supported purposes

| Purpose | Data categories | Background job |
|---|---|---|
| `credit_score_processing` | `wallet_address`, `loan_history`, `credit_score` | `scoreDecayJob` |
| `remittance_analytics` | `remittance_history`, `wallet_address` | (future) |
| `marketing_communications` | `contact_info` | notification service |
| `third_party_sharing` | `credit_score`, `loan_history`, `remittance_history` | (future) |

Adding a new purpose requires:
1. Extending the `CHECK` constraint in a new migration.
2. Adding the purpose to `CONSENT_PURPOSES` in `consentLedgerService.ts`.
3. Updating `PURPOSE_LABELS` in `settings/page.tsx`.

---

## API endpoints

All write endpoints require `Authorization: Bearer <jwt>` and `Idempotency-Key` header.

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/user/consent/meta` | Public | Supported purposes, data categories, policy version |
| `GET` | `/user/consent` | JWT | Effective consent for every purpose |
| `GET` | `/user/consent/history` | JWT | Paginated append-only history |
| `POST` | `/user/consent/grant` | JWT + rate-limit | Record a consent grant |
| `POST` | `/user/consent/revoke` | JWT + rate-limit | Record a consent revocation |

### POST /user/consent/grant

```json
{
  "purpose": "credit_score_processing",
  "policy_version": "1.0",
  "data_categories": ["credit_score", "wallet_address", "loan_history"]
}
```

Returns `201` with the created consent record.

### POST /user/consent/revoke

```json
{
  "purpose": "credit_score_processing",
  "revocation_reason": "No longer needed"
}
```

Returns `200` with the revocation record.
Returns `404` if no active grant exists for the purpose.
Returns `409` if the consent is already revoked.

---

## Idempotency

- Global `idempotencyMiddleware` caches all 2xx/4xx responses in Redis for 24 h.
- The `idempotency_key UNIQUE` constraint on `consent_ledger` provides a database-level
  second line of defence. A duplicate key returns the existing row rather than failing.

---

## Downstream-job enforcement

Every background job that processes user-sensitive data MUST call:

```typescript
import { isConsentGranted } from '../services/consentLedgerService.js';

const allowed = await isConsentGranted(userId, 'credit_score_processing');
if (!allowed) {
  // skip this user — do not process
  continue;
}
```

`isConsentGranted` checks the `consent_effective` view and also compares the
stored `policy_version` against the minimum required version. If the user's
consent was recorded against an older policy the function returns `false`,
requiring a fresh grant.

Currently wired: `scoreDecayJob` (credit score decay for all users).

---

## Policy version comparison

`isConsentGranted(userId, purpose, minimumPolicyVersion)` compares versions as
numeric `MAJOR.MINOR` tuples:

| Stored version | Minimum required | Result |
|---|---|---|
| `1.0` | `1.0` | ✅ granted |
| `2.1` | `1.0` | ✅ granted |
| `1.0` | `2.0` | ❌ stale — re-consent required |

---

## Audit trail

Every state transition writes two records:
1. A new row in `consent_ledger` (the durable source of truth).
2. A row in `audit_logs` (actor, `CONSENT_GRANTED` / `CONSENT_REVOKED`, target, detail JSON).

---

## Migration

File: `backend/migrations/1810000000000_consent-ledger.js`

```bash
npm run db:migrate
```

The migration is fully reversible via `down` (drops table, trigger, function, view).

---

## Testing

### Backend

```bash
cd backend
npm test -- --testPathPattern=consentLedgerService
```

Covers: grant happy path, idempotency (dup key), all validation guards, revoke happy path,
revoke-404, revoke-409, listConsentHistory filters, getEffectiveConsents, isConsentGranted
version comparison, downstream-job enforcement contract.

### Frontend

```bash
cd frontend
npm test -- --testPathPattern=PrivacySection
```

Covers: render four purpose rows, Consented/Not-consented badges, grant/revoke
mutation payloads, success/error toasts, history accordion, empty history state.

---

## Schema / migration compatibility

No existing tables are modified. The `consent_ledger` table and `consent_effective` view
are purely additive. No OpenAPI changes are required beyond the new routes (the Swagger
JSDoc in `userRoutes.ts` documents them). No frontend build changes.
