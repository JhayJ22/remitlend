# Annual Threat-Model Refresh Gate for Changed Trust Boundaries

> Issue #856 — automate a change inventory for wallet, provider, API, and
> contract trust boundaries; require reviewed threat-model updates and tracked
> mitigations before production release.

## Overview

RemitLend's security posture depends on explicit trust boundaries between its
components (browser wallet, Stellar/Soroban provider, API surface, smart
contracts, and infrastructure). When a code change moves through one of these
boundaries, the threat model for that boundary must have been reviewed and
approved within the last 365 days.

This gate enforces that requirement automatically:

1. **CI** classifies every changed file against a boundary pattern map.
2. If any touched boundary lacks a current approved review, the PR is **blocked**.
3. Admins initiate and approve reviews via the API; the status is committed into
   `docs/THREAT_MODEL_REVIEW_STATUS.json` and read by the CI gate.
4. Every review and every gate decision (passed / gated / forced) is recorded in
   the database and mirrored to `audit_logs`.

## Trust boundaries

| Boundary | What it covers | Pattern match examples |
|----------|---------------|------------------------|
| `wallet` | Browser wallet integration, challenge-nonce auth, JWT auth | `authService`, `jwtAuth`, `challengeNonceService`, `useWallet` |
| `provider` | Stellar RPC, PII KMS, key rotation, backup | `sorobanService`, `stellar.ts`, `piiCrypto`, `backupService` |
| `api` | HTTP routes, rate limiting, request schemas | `routes/`, `middleware/auth`, `middleware/rateLimiter`, `schemas/` |
| `contract` | Soroban contracts, contract verification, deploy scripts | `contracts/`, `contractVerification`, `scripts/deploy` |
| `infra` | Docker, CI workflows, DB migrations, env config | `docker-compose`, `.github/workflows/`, `migrations/`, `src/config/` |

## Review lifecycle states

```
(admin initiates) → draft
                 → approved   (second admin approves; counts as current for 365 days)
                 → superseded (a newer review for the same boundary was approved)
```

A review is "current" if `status='approved'` and `approved_at > NOW() - 365 days`.

## Authorization

| Operation | Required role |
|-----------|--------------|
| Initiate review | `admin` (JWT) |
| Approve review | `admin` (JWT); self-approval blocked |
| Record boundary change | `admin` (JWT); `forced=true` requires `force_reason` |
| Read reviews / changes | `admin` (JWT) |
| CI gate check (`/gate-check`) | `admin` (JWT) |

## Review workflow

### Step 1 — Reviewer initiates

```bash
# Compute the SHA-256 hash of the current threat-model document.
HASH=$(sha256sum docs/SECURITY-ASSUMPTIONS.md | awk '{print $1}')

curl -X POST https://api.remitlend.app/admin/threat-model/reviews \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "boundary": "api",
    "document_hash": "'"$HASH"'",
    "mitigations": [
      { "id": "M-1", "description": "Rate limiter updated to cover new admin routes", "status": "addressed" }
    ],
    "approval_ref": "pr-884"
  }'
# → 202 { "data": { "id": "<uuid>", "status": "draft" } }
```

### Step 2 — Second admin approves

```bash
curl -X POST https://api.remitlend.app/admin/threat-model/reviews/<uuid>/approve \
  -H "Authorization: Bearer $SECOND_ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d '{ "approval_ref": "pr-884" }'
# → 200 { "data": { "status": "approved", "approved_at": "..." } }
```

### Step 3 — Update the status file and commit

```bash
# Fetch the current review status for all boundaries.
curl https://api.remitlend.app/admin/threat-model/reviews/current \
  -H "Authorization: Bearer $JWT" \
  | jq '.data.reviews' > docs/THREAT_MODEL_REVIEW_STATUS.json

git add docs/THREAT_MODEL_REVIEW_STATUS.json
git commit -m "security: update threat-model review status for api boundary"
```

### Step 4 — CI gate passes automatically

The `threat-model-gate.yml` workflow reads `docs/THREAT_MODEL_REVIEW_STATUS.json`
and calls `scripts/check-trust-boundaries.mjs`. With the updated status file
committed, the gate passes.

## Gate override (emergency)

Set `THREAT_MODEL_GATE_OVERRIDE=true` as a repository secret to bypass the gate.

**This is an emergency escape only.** Every bypass is:
- Logged in the CI step summary.
- Recorded as `gate_status='forced'` in `trust_boundary_changes` with `forced_by` and `force_reason`.
- Mirrored to `audit_logs`.
- Requires a proper review to be completed before the next production release.

```bash
# Record the forced override via the API.
curl -X POST https://api.remitlend.app/admin/threat-model/changes \
  -H "Authorization: Bearer $JWT" \
  -d '{
    "boundary": "api",
    "change_ref": "pr-999",
    "description": "Emergency hotfix",
    "changed_files": ["backend/src/routes/adminRoutes.ts"],
    "force": true,
    "force_reason": "Critical CVE fix; review scheduled within 48h"
  }'
```

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/admin/threat-model/reviews` | Initiate a review (draft) |
| `POST` | `/admin/threat-model/reviews/:id/approve` | Second-admin approval |
| `GET` | `/admin/threat-model/reviews` | List reviews |
| `GET` | `/admin/threat-model/reviews/current` | Current approved review per boundary |
| `GET` | `/admin/threat-model/reviews/:id` | Single review + days_until_expiry |
| `POST` | `/admin/threat-model/changes` | Record a boundary change |
| `GET` | `/admin/threat-model/changes` | Change inventory |
| `POST` | `/admin/threat-model/gate-check` | Run gate check for a file list |

## Compatibility and migration

- Migration `1809000000004_threat-model-reviews` is **additive** — no existing
  column is modified. Down migration drops both tables cleanly.
- `docs/THREAT_MODEL_REVIEW_STATUS.json` is a new file; it must be committed
  alongside each review approval.
- The CI workflow (`threat-model-gate.yml`) is new and does not affect existing
  passing jobs — it runs in parallel with the existing `ci.yml` jobs.

## Validation evidence

```bash
# Run the focused test suite (no database required — pool is fully mocked):
cd backend
npm test -- --runTestsByPath src/services/__tests__/threatModelRefreshService.test.ts
# Expected: Tests: 33 passed

# Test the CI script locally (empty diff → no boundaries touched → passes):
echo "" | node scripts/check-trust-boundaries.mjs
# Expected: exit 0, all_passed: true

# Test with a contract-touching file (no reviews → gate blocks):
echo "contracts/lending_pool/src/lib.rs" | node scripts/check-trust-boundaries.mjs
# Expected: exit 1, all_passed: false
```

Covers: file classification (all 5 boundaries), hash determinism + tamper
detection, initiate review (success, duplicate rejection, bad boundary, audit
failure non-blocking), approve review (success, self-approval blocked, 404,
409), getCurrentReview / checkGate (pass, fail), recordBoundaryChange (passed,
gated, forced, missing forceReason), generateChangeInventory (all-pass, partial
fail, no boundaries), listReviews (pagination, nextCursor), getReview (200+404).
