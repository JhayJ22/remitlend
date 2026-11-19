# Secrets Inventory

This document tracks the secrets used by the platform, where they live, and how they are protected. It is a reference for operators and contributors; it does **not** itself enforce anything. Enforcement is provided by the automated secret scanning described below.

## Secret scanning

Secret scanning is enforced in two places so that credentials are never committed to the repository:

### 1. Pre-commit hook (local)

A Husky pre-commit hook runs Gitleaks against staged changes before every commit:

```sh
gitleaks protect --staged --redact
```

If a secret is detected, the commit is blocked. To proceed you must remove the secret from the staged changes (and rotate it if it was ever pushed). Do **not** bypass the hook with `--no-verify`.

Install Gitleaks locally (see https://github.com/gitleaks/gitleaks) and ensure it is on your `PATH` before committing.

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
