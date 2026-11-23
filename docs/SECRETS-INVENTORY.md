# Secrets Inventory

This document tracks the secrets used by the platform, where they live, and how they are protected. It is a reference for operators and contributors; it does **not** itself enforce anything. Enforcement is provided by the automated secret scanning described below.

## Secret scanning

Secret scanning is enforced in two places so that credentials are never committed to the repository:

### 1. Pre-commit hook (local)

| Secret class | Impact if exposed |
|---|---|
| `JWT_SECRET` | Forge JWT tokens for any user, including admin. |
| `INTERNAL_API_KEY` | Call any scoped internal API endpoint without a valid JWT. |
| `AUDIT_LOG_KEY` | Re-forge the audit-log HMAC chain so edited or deleted entries pass verification. |
| `LOAN_MANAGER_ADMIN_SECRET` | Submit on-chain admin transactions (approve loans, pause contracts). |
| `SCORE_RECONCILIATION_SOURCE_SECRET` | Read-only Stellar key; can enumerate borrower scores. |
| `SENDGRID_API_KEY` | Send arbitrary email from the RemitLend domain. |
| `TWILIO_AUTH_TOKEN` / `TWILIO_ACCOUNT_SID` | Send SMS from the RemitLend number. |
| `SENTRY_AUTH_TOKEN` | Upload source maps; can deanonymise stack traces. |
| `DATABASE_URL` | Full read/write access to the PostgreSQL database (PII, loan data). |
| `REDIS_URL` | Read/write rate-limit counters, JWT revocation list, idempotency keys. |
| `STATEMENT_SIGNING_PRIVATE_KEY_PEM` | Forge signed statement manifests for any wallet. |
| `STATEMENT_SUBJECT_PEPPER` | Correlate daily subject hashes in statement manifests back to wallets. |
A Husky pre-commit hook runs Gitleaks against staged changes before every commit:

```sh
gitleaks protect --staged --redact
```

If a secret is detected, the commit is blocked. To proceed you must remove the secret from the staged changes (and rotate it if it was ever pushed). Do **not** bypass the hook with `--no-verify`.

Install Gitleaks locally (see https://github.com/gitleaks/gitleaks) and ensure it is on your `PATH` before committing.

| Variable | Classification | Rotation policy | Notes |
|---|---|---|---|
| `JWT_SECRET` | **Secret** | Rotate every 90 days or on suspected compromise | Min 32 bytes, random. Invalidates all active sessions on rotation. |
| `AUDIT_LOG_KEY` | **Secret — key custody** | Rotate only together with a chain checkpoint (see note) | Min 32 bytes, random. HMAC-SHA256 key for the tamper-evident `audit_logs` chain (#796). **Must differ from `JWT_SECRET`**; audit writes fail if the two match. Required when `NODE_ENV=production`. Keep it in the secrets manager, and give it to the backend only — never to DB administrators. Anyone who holds both this key and DB write access can rewrite history without detection. Before rotating, export and verify the chain up to the rotation time (`GET /admin/audit-logs/export`, `POST /admin/audit-logs/verify`) and archive that export: entries written under the old key can only be verified with the old key. |
| `INTERNAL_API_KEY` | **Secret** | Rotate every 90 days or on staff offboarding | Comma-separated list of scoped keys; see `docs/SECURITY-MODEL.md`. |
| `LOAN_MANAGER_ADMIN_SECRET` | **Secret — high risk** | Rotate on any suspected compromise | Stellar secret key (`S…`). Controls on-chain admin operations. Store in HSM/vault in production. |
| `SCORE_RECONCILIATION_SOURCE_SECRET` | **Secret** | Rotate every 180 days | Read-only Stellar key for score reads. |
| `DATABASE_URL` | **Secret** | Managed by infrastructure team | Contains username and password for PostgreSQL. |
| `REDIS_URL` | **Secret** | Managed by infrastructure team | May contain auth token depending on Redis ACL config. |
| `SENDGRID_API_KEY` | **Secret** | Rotate annually or on suspected compromise | Restricted to sending only; never grant template/domain management. |
| `TWILIO_ACCOUNT_SID` | **Semi-public** | N/A | Not a secret by itself but combined with `TWILIO_AUTH_TOKEN` grants full API access. |
| `TWILIO_AUTH_TOKEN` | **Secret** | Rotate annually or on suspected compromise | |
| `SENTRY_DSN` | **Non-secret** | N/A | Public ingest URL; safe to expose. |
| `STATEMENT_SIGNING_PRIVATE_KEY_PEM` | **Secret — high risk** | Rotate on suspected compromise or scheduled key rotation | PKCS#8 PEM for Ed25519 statement manifest signing. Never returned by any API; see `docs/STATEMENT_VERIFICATION.md`. |
| `STATEMENT_SIGNING_KEY_ID` | **Non-secret** | Update when rotating the signing key | Identifies the public key verifiers must use. |
| `STATEMENT_SUBJECT_PEPPER` | **Secret** | Rotate every 90 days or on suspected compromise | Daily salt for non-reversible manifest subject hashes. Rotation changes subject hashes but not signatures over already-issued manifests. |
### 2. CI supply-chain audit (remote)

The reusable supply-chain audit workflow (`.github/workflows/reusable-supply-chain-audit.yml`) runs a full-repository scan on every push and pull request:

```sh
gitleaks detect --source . --redact --verbose
```

The job fails if any secret is found, blocking the merge.

### Rules

Custom detection rules live in `.gitleaks.toml` and include:

- **Stellar secret keys** — `S`-prefixed 56-character base32 strings.
- **JWT tokens** — common JSON Web Token patterns.

Allowlist / false-positive entries in `.gitleaks.toml` are annotated with comments explaining why each is safe.

### Procedure when a secret is detected

1. **Do not** commit or push the secret.
2. Remove the secret from the working tree / staged changes.
3. If the secret was already pushed, **rotate it immediately** at the issuing provider.
4. Update this inventory and the consuming configuration to reference the rotated value via the secret store (never inline).
5. If the finding is a genuine false positive, add a narrowly-scoped, commented allowlist entry to `.gitleaks.toml` and open a PR for review.

## Inventory

| Secret | Purpose | Storage | Rotation |
| --- | --- | --- | --- |
| `STELLAR_SECRET_KEY` | Server signing key for Stellar transactions | Secret store / CI secrets | Rotate on suspected exposure |
| `JWT_SECRET` | Signs authentication tokens | Secret store / CI secrets | Rotate on suspected exposure |
| `DATABASE_URL` | Database connection string (may embed credentials) | Secret store / CI secrets | Rotate on suspected exposure |

> Add new secrets to this table when introduced, and confirm they are covered by the scanning rules above.
