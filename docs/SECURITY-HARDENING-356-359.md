# Security Hardening — Issues #356, #357, #358, #359, #806, #807, #808, #809

This document describes the security controls implemented to address four
security issues filed against RemitLend. It serves as the threat-model notes,
compatibility impact assessment, rollout steps, and verification evidence
required by each issue's acceptance criteria.

---

## Issue #356 — Commission invariant-based economic attack review

### What was the issue?

The LendingPool contract uses a share-based (ERC-4626-style) accounting model
with `TotalManagedAssets` as the single source of truth for share pricing. No
automated tests verified that the economic invariants hold across adversarial
scenarios (donation attacks, flashloan manipulation, late-join yield extraction).

### Changes made

| File | Change |
|---|---|
| `contracts/lending_pool/src/commission_invariants.rs` | New: 6 deterministic invariant tests (INV-LP-1 through INV-LP-6) |
| `contracts/lending_pool/src/lib.rs` | Added `mod commission_invariants` declaration |
| `backend/src/__tests__/commissionInvariants.test.ts` | New: API-layer fee arithmetic and share-price tests |

### Invariants tested

| ID | Invariant | Attack mitigated |
|---|---|---|
| INV-LP-1 | Share price is non-decreasing across deposit/withdraw cycles | Rounding-direction exploit |
| INV-LP-2 | Donation (direct token transfer) cannot move TotalManagedAssets | ATK-1: share-price inflation via donation |
| INV-LP-3 | Late depositors cannot extract yield distributed before their entry | ATK-2: late-join yield extraction |
| INV-LP-4 | Granular pause flags gate only their declared operations | ATK-6: operation bypass via partial pause |
| INV-LP-5 | TotalManagedAssets equals pool balance when no loans are outstanding | Accounting divergence |
| INV-LP-6 | Slippage guards reject adverse share-price moves | Front-running / MEV |
| INV-API-1 | fee(0) == 0 for all rates | Zero-principal drain |
| INV-API-2 | Fee never exceeds principal × MAX_RATE_BPS / 10_000 | Integer overflow |
| INV-API-3 | Fee config parameters are bounded by their on-chain caps | Admin parameter abuse |
| INV-API-4 | Deposit → immediate withdraw returns ≤ deposited amount | Round-trip profit |
| INV-API-5 | Extension fee is bounded by EXTENSION_FEE_BPS × remaining principal | Fee inflation |

### Compatibility impact

Tests-only change. No production code paths are modified. Existing contract
deployments are unaffected.

### Rollout

Tests run automatically on every PR and push to `main` via the `contracts` and
`backend` CI jobs.

---

## Issue #357 — Complete API abuse-case matrix and rate-limit policy

### What was the issue?

The rate-limiting configuration existed in `rateLimiter.ts` but there was no
documented mapping from each abuse case to its specific rate-limiter, and no
tests asserting that each dangerous endpoint group was covered with the correct
window and max-request settings.

### Changes made

| File | Change |
|---|---|
| `backend/src/__tests__/apiAbuseCaseMatrix.test.ts` | New: 12-case abuse matrix with rate-limit configuration assertions |

### Abuse cases covered

| ID | Vector | Endpoint | Limiter | Window | Max |
|---|---|---|---|---|---|
| AC-1 | Brute-force challenge nonce | POST /api/auth/challenge | `challengeRateLimiter` | 1 min | 10 |
| AC-2 | Credential stuffing | POST /api/auth/login | `loginRateLimiter` + `ipLoginRateLimiter` | 1 min | 5 |
| AC-3 | Token-validation DoS | GET /api/auth/verify | `verifyRateLimiter` | 1 min | 10 |
| AC-4 | Simulation flooding | POST /api/simulate/* | `simulationRateLimiter` | 1 min | 5 |
| AC-5 | Score-update farming | POST /api/score/update | `scoreUpdateRateLimit` | 24 h | 5 |
| AC-6 | Admin endpoint enumeration | /api/admin/* | `strictRateLimiter` | 45 min | 10 |
| AC-7 | Global API flooding | All endpoints | `globalRateLimiter` | 15 min | 100 |
| AC-8 | Oversized payload DoS | Any POST/PATCH | `express.json({ limit: '100kb' })` | — | 100 KB |
| AC-9 | CSRF | Authenticated routes | CORS + `SameSite=strict` cookie | — | — |
| AC-10 | JWT-less privileged access | Scoped routes | `requireJwtAuth` / `requireApiKey` | — | — |
| AC-11 | Score-update replay | POST /api/score/update | Idempotency key + Redis dedupe | — | — |
| AC-12 | Pagination parameter abuse | GET /api/loans/* | Validated limit/offset (max 100) | — | — |

### Compatibility impact

Tests-only change. Rate-limiter values are read from the existing production
instances; no configuration was changed.

### Rollout

Tests run automatically via the `backend` CI job on every PR.

---

## Issue #358 — Audit wallet signing UX for confused-deputy attacks

### What was the issue?

The wallet signing flow (XDR builders + `TransactionPreviewModal`) had no
automated tests verifying that the encoded contract address, function name,
amounts, borrower address, network passphrase, and transaction timeout exactly
match the values shown to the user before signing.

### Changes made

| File | Change |
|---|---|
| `frontend/src/app/utils/confusedDeputy.test.ts` | New: 14 tests covering all 7 confused-deputy vectors |

### Vectors audited

| ID | Attack | Guard | Test |
|---|---|---|---|
| CD-1 | Contract address substitution | XDR built with `contractId`; different IDs produce different XDRs | ✅ |
| CD-2 | Function name mismatch | Function name decoded from XDR and asserted | ✅ |
| CD-3 | Amount substitution | Amount ScVal decoded and compared to input | ✅ |
| CD-4 | Borrower address substitution | Borrower ScVal decoded and compared to signer | ✅ |
| CD-5 | Network passphrase mismatch | Testnet and mainnet hashes diverge | ✅ |
| CD-6 | Transaction replay (stale XDR) | Timeout ≤ 300 s asserted on every unsigned XDR | ✅ |
| CD-7 | Fee escalation | `buildUnsigned*Xdr` hard-codes fee=10_000 stroops | ✅ (via CD-2 XDR inspection) |

### Existing mitigations confirmed

- `TransactionPreviewModal` shows `network`, `contractAddress`, operation type,
  amount, and token before the user signs.
- `useTransactionPreview` keeps the modal open on error so users can retry or
  inspect before re-signing.
- `buildUnsignedLoanRequestXdr` and `buildUnsignedRepaymentXdr` call
  `.setTimeout(300)` on every transaction, limiting the replay window.

### Compatibility impact

Tests-only change. No production frontend code is modified.

### Rollout

Tests run automatically via the `frontend` CI job on every PR.

---

## Issue #359 — Secrets inventory and automated exposure scanning

### What was the issue?

There was no centralised inventory of all secrets used across the stack, no
documented rotation policy, and no CI job that would catch accidentally
committed secrets or placeholder values left in code.

### Changes made

| File | Change |
|---|---|
| `docs/SECRETS-INVENTORY.md` | New: canonical inventory with classification, rotation policy, and emergency response |
| `.gitleaks.toml` | New: gitleaks configuration with project-specific allow-list for CI/test placeholders |
| `.github/workflows/ci.yml` | Added `secrets-scan` job using `gitleaks/gitleaks-action@v2` + grep heuristics |
| `backend/src/__tests__/secretsInventory.test.ts` | New: runtime assertions that secrets are not logged, leaked in responses, or set to placeholder values |

### Secrets inventoried

See [docs/SECRETS-INVENTORY.md](SECRETS-INVENTORY.md) for the complete table.
High-risk secrets:

- `JWT_SECRET` — forged tokens → full account takeover
- `INTERNAL_API_KEY` — admin API bypass
- `LOAN_MANAGER_ADMIN_SECRET` — on-chain admin control

### CI job behaviour

The `secrets-scan` job:

1. Checks out the **full git history** (`fetch-depth: 0`) so past commits are scanned.
2. Runs `gitleaks detect` with the default ruleset plus project-specific allow-list.
3. Runs a grep-based heuristic scan for known placeholder values.
4. Fails the build if any match is found outside documented allow-list entries.

`.env.example` files are excluded from the grep scan because they are permitted
to contain placeholder documentation values.

### Compatibility impact

The `secrets-scan` job is additive. Existing CI jobs are not modified.
The `.gitleaks.toml` allow-list entries prevent false positives on the
test-fixture values already committed in `ci.yml`.

### Rollout

1. Merge this PR — the `secrets-scan` job activates on the next push.
2. Rotate any secrets that are currently set to placeholder values in staging/production.
3. Fill in the "Last rotated" table in `docs/SECRETS-INVENTORY.md`.

---

## Verification evidence

| Issue | How to verify |
|---|---|
| #356 | `cd contracts && cargo test -p lending_pool commission_invariants` and `cd backend && npm test -- commissionInvariants` |
| #357 | `cd backend && npm test -- apiAbuseCaseMatrix` |
| #358 | `cd frontend && npm test -- confusedDeputy` |
| #359 | `cd backend && npm test -- secretsInventory`; inspect `secrets-scan` job in GitHub Actions |
| #806 | `cd backend && npm test -- security-issues` — look for the "Issue #806" describe block |
| #807 | `cd contracts && cargo test -p lending_pool` — all three runtime invariants panic on violation; fuzz target at `contracts/fuzz/fuzz_targets/lending_pool_fuzz.rs` |
| #808 | `cd frontend && npx playwright test e2e/theme-switcher.spec.ts` and `npm run storybook` → Global UI/ThemeSwitcher |
| #809 | `cd backend && npm test -- loadShedding`; env vars `LOAD_SHED_LAG_MS` / `LOAD_SHED_HEAP_PCT` control thresholds |

---

## Issue #806 — Comprehensive input sanitization and injection prevention

### What was the issue?

User-supplied string fields (loan reason, dispute note, notification message
body) were stored without consistent sanitization, creating XSS and SQL
injection vectors for downstream consumers.

### Changes made

| File | Change |
|---|---|
| `backend/src/utils/sanitize.ts` | New: `sanitizeText` and `sanitizeFields` utility |
| `backend/src/schemas/loanSchemas.ts` | Added `contestDefaultSchema`, `disputeNoteSchema`; upgraded `rejectLoanSchema` max to 1 000 |
| `backend/src/controllers/loanDisputeController.ts` | Sanitize `reason` before storage |
| `backend/src/controllers/adminDisputeController.ts` | Sanitize `note`, `adminNote`, `resolution`, `admin_note` |
| `backend/src/controllers/loanLifecycleController.ts` | Sanitize parsed `reason` before passing to Soroban |
| `backend/src/__tests__/security-issues.test.ts` | Added XSS, SQL metacharacter, and Unicode normalization vectors |
| `backend/Dockerfile` | Added `CSP_DEFAULT_SRC` env-var anchor to reinforce CSP documentation |

### Sanitization rules

1. Unicode NFC normalization (collapse homoglyph bypass attempts).
2. HTML / XML tag stripping (`<` … `>` and everything inside).
3. SQL metacharacter removal: backtick, null byte, `--` → `-`, `/*` and `*/`, URL-encoded sequences.
4. Whitespace trimming.
5. Length truncation to `maxLength` (default 1 000 characters).

### Compatibility impact

Sanitization is applied at the controller layer after Zod validation.
Existing stored values are unaffected; new writes are cleaned before INSERT.

---

## Issue #807 — Lending pool invariant assertions

### What was the issue?

The lending pool's share price had no runtime assertion ensuring it was
monotonically non-decreasing. A silent miscalculation in yield distribution
could reduce the share price without any on-chain signal.

### Changes made

| File | Change |
|---|---|
| `contracts/lending_pool/src/lib.rs` | Added `PoolError::InvariantViolation`, `assert_invariants` helper, and calls in `deposit`, `redeem_shares`, `distribute_yield` |
| `contracts/lending_pool/src/commission_invariants.rs` | Updated header to document the three runtime invariants (INV-RT-1/2/3) |
| `contracts/fuzz/fuzz_targets/lending_pool_fuzz.rs` | Rewritten to cover `DistributeYield` and to assert all three invariants after every operation |

### Invariants enforced (panics + roll-back on violation)

| ID | Invariant | Operations |
|---|---|---|
| INV-RT-1 | Share price non-decreasing: `new_managed × (prev_shares + V) ≥ prev_managed × (new_shares + V)` | deposit, distribute_yield |
| INV-RT-2 | No dilution: `total_managed ≥ total_deposits` | all three |
| INV-RT-3 | Conservation: `pool_balance + total_outstanding ≤ total_managed` | all three |

Soroban's atomic transaction semantics guarantee any panic rolls back the full
state change before it is committed to the ledger.

### Compatibility impact

The new `PoolError::InvariantViolation = 20` discriminant is additive.
Existing clients that match only the error codes they know are unaffected.

---

## Issue #808 — Dark/light theme switcher

### What was the issue?

The UI had no three-way toggle and always rendered the dark Obsidian theme
regardless of system preferences. Users preferring light mode (accessibility,
outdoor use) had no option.

### Changes made

| File | Change |
|---|---|
| `frontend/src/app/components/global_ui/ThemeSwitcher.tsx` | New: three-mode switcher component |
| `frontend/src/app/components/global_ui/ThemeSwitcher.stories.tsx` | New: Storybook stories (Light, Dark, System, AllModes) |
| `frontend/src/app/components/global_ui/Header.tsx` | Replaced `ThemeToggle` import with `ThemeSwitcher` |
| `frontend/e2e/theme-switcher.spec.ts` | New: Playwright spec covering all three modes, persistence, system-preference override |

### Mode behaviour

| Mode | `<html>` class | Persisted as |
|---|---|---|
| `light` | (no `dark` class) | `remitlend-theme=light` |
| `dark` | `dark` | `remitlend-theme=dark` |
| `system` | Follows OS `prefers-color-scheme` live | `remitlend-theme=system` |

### Compatibility impact

UI-only change. The existing `useThemeStore` and `lib/theme.ts` logic is
unchanged; `ThemeSwitcher` is a drop-in companion to the original `ThemeToggle`.

---

## Issue #809 — Load-shedding middleware

### What was the issue?

Under extreme load the backend accepted all incoming requests until
memory-exhaustion or event-loop starvation. There was no mechanism to return
`503` and allow orchestrators to route traffic away.

### Changes made

| File | Change |
|---|---|
| `backend/src/middleware/loadShedding.ts` | New: `loadSheddingMiddleware`, `requestsShedTotal` Prometheus counter |
| `backend/src/app.ts` | Registered `loadSheddingMiddleware()` after `globalRateLimiter` |
| `backend/src/middleware/__tests__/loadShedding.test.ts` | New: 12 tests with mocked metrics |
| `docs/DEPLOYMENT.md` | Added "Load Shedding" section with thresholds, env vars, alert example |

### Thresholds

| Metric | Env var | Default |
|---|---|---|
| Event-loop lag | `LOAD_SHED_LAG_MS` | 100 ms |
| Heap usage | `LOAD_SHED_HEAP_PCT` | 85 % |

### Compatibility impact

The middleware is purely additive. Existing routes, middleware, and tests are
unaffected. Health endpoints (`/health`, `/healthz/*`, `/metrics`) are exempt.
