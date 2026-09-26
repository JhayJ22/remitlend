# Production Readiness Rubric for Integrations

Use this rubric to assess whether a new integration — a backend service, a
frontend consumer, or an external partner connection — is ready for production
traffic. Each dimension is scored 0–3. A total score of **≥ 32 / 39** is
required to proceed.

Integrations below the threshold must document a time-boxed remediation plan
before deployment approval.

---

## Table of Contents

- [How to Use This Rubric](#how-to-use-this-rubric)
- [Scoring Key](#scoring-key)
- [Dimension 1 — Correctness & Validation](#dimension-1--correctness--validation)
- [Dimension 2 — Authorization & Authentication](#dimension-2--authorization--authentication)
- [Dimension 3 — Failure & Retry Behaviour](#dimension-3--failure--retry-behaviour)
- [Dimension 4 — Observability](#dimension-4--observability)
- [Dimension 5 — Data Integrity](#dimension-5--data-integrity)
- [Dimension 6 — Security](#dimension-6--security)
- [Dimension 7 — Performance & Scalability](#dimension-7--performance--scalability)
- [Dimension 8 — Rollback & Rollout](#dimension-8--rollback--rollout)
- [Dimension 9 — Documentation](#dimension-9--documentation)
- [Dimension 10 — On-Call Readiness](#dimension-10--on-call-readiness)
- [Dimension 11 — Migration & Schema Safety](#dimension-11--migration--schema-safety)
- [Dimension 12 — Dependency Health](#dimension-12--dependency-health)
- [Dimension 13 — Financial Arithmetic](#dimension-13--financial-arithmetic)
- [Scorecard Template](#scorecard-template)
- [Threat Model Notes](#threat-model-notes)
- [Rollout Steps](#rollout-steps)

---

## How to Use This Rubric

1. Copy the [Scorecard Template](#scorecard-template) into your PR or
   deployment ticket.
2. Score each dimension honestly. Include evidence (test output, log samples,
   runbook links) for scores of 2 or 3.
3. A reviewer from the platform or ops team must countersign the scorecard
   before merging to `main` or deploying.
4. File a follow-up issue for any dimension scored below 2, linking it in the
   scorecard.

---

## Scoring Key

| Score | Meaning |
|-------|---------|
| 0 | Not addressed |
| 1 | Partial / in progress |
| 2 | Meets minimum bar |
| 3 | Exemplary |

---

## Dimension 1 — Correctness & Validation

**Weight:** 3 (critical path correctness)

| Score | Evidence expected |
|-------|-----------------|
| 0 | No input validation |
| 1 | Happy-path validation only; edge cases undocumented |
| 2 | All required fields validated; schema enforced with a library (e.g. Zod); error messages are user-actionable |
| 3 | Property-based or fuzz tests cover boundary values; validation is centralised and reusable |

Checks:
- All external inputs are validated before processing.
- Numeric values use integer or decimal types — no floating-point for money.
- Maximum lengths enforced on string fields.
- Enum fields reject unknown values.

---

## Dimension 2 — Authorization & Authentication

**Weight:** 3 (security-critical)

| Score | Evidence expected |
|-------|-----------------|
| 0 | No auth checks |
| 1 | Auth checked on some routes but not all |
| 2 | Every route requiring auth is gated; JWT verified; roles enforced |
| 3 | Auth tests cover unauthenticated, wrong-role, and expired-token scenarios; HMAC used where applicable |

Checks:
- Unauthenticated requests return `401`.
- Insufficient-privilege requests return `403`.
- JWT expiry is respected.
- Webhook deliveries verified with HMAC (see
  [webhook-consumer-certification.md](webhook-consumer-certification.md)).

---

## Dimension 3 — Failure & Retry Behaviour

**Weight:** 3 (availability)

| Score | Evidence expected |
|-------|-----------------|
| 0 | No error handling |
| 1 | Errors caught but not differentiated; all failures look the same |
| 2 | Transient errors retried with backoff; permanent errors propagated; circuit breaker or timeout in place |
| 3 | Retry policy is configurable; max attempts bounded; dead-letter queue for exhausted retries; integration test covers dependency failure |

Checks:
- Network timeouts do not hang the calling service indefinitely.
- Retries use exponential backoff with jitter.
- Idempotency keys prevent duplicate effects on retry (see
  [idempotency-contract.md](idempotency-contract.md)).
- Failed webhook deliveries are not silently discarded.

---

## Dimension 4 — Observability

**Weight:** 3

| Score | Evidence expected |
|-------|-----------------|
| 0 | No logs or metrics |
| 1 | `console.log` only; no structured fields |
| 2 | Structured JSON logs with `level`, `message`, `correlationId`, `userId` where applicable; key paths emit timing metrics |
| 3 | Distributed traces, dashboards for success/error rates, p99 latency, and queue depth; alerts wired to on-call |

Checks:
- All errors logged with stack trace and context.
- Business events (loan approved, repaid, defaulted) produce audit log entries.
- `correlationId` / `requestId` threaded through all log lines for a request.
- Alert thresholds defined and documented in the runbook.

---

## Dimension 5 — Data Integrity

**Weight:** 3

| Score | Evidence expected |
|-------|-----------------|
| 0 | No constraints; data can be silently corrupted |
| 1 | Application-level checks only |
| 2 | Database constraints (NOT NULL, UNIQUE, FK) enforce invariants; migration tested against production data shape |
| 3 | Dual-write / reconciliation path tested; cross-contract state verified by `scoreReconciliationService` or equivalent |

Checks:
- Scores clamped to 300–850 (application layer + documented invariant).
- Financial amounts stored as stroops (integers), not floats.
- `event_id` unique constraint prevents duplicate indexing.
- Reconciliation path (`setAbsoluteUserScoresBulk`) tested in isolation.

---

## Dimension 6 — Security

**Weight:** 3 (required for any user-data path)

| Score | Evidence expected |
|-------|-----------------|
| 0 | Known vulnerabilities; no dependency scanning |
| 1 | Dependencies scanned; no critical CVEs; no additional hardening |
| 2 | Input sanitised; parameterised queries; PII encrypted at rest; Trivy/CodeQL clean |
| 3 | Threat model documented; penetration test or security review completed; SAST pipeline green |

Checks:
- No SQL injection vectors (parameterised queries only).
- PII fields encrypted at rest (see `piiCrypto.ts`).
- CORS restricted to approved origins.
- Secrets managed via environment variables or secret manager — not committed to source.
- `SECURITY.md` covers the integration's threat surface if new attack vectors are introduced.

---

## Dimension 7 — Performance & Scalability

**Weight:** 2

| Score | Evidence expected |
|-------|-----------------|
| 0 | No performance testing; no timeouts |
| 1 | Manual spot-check; no baseline |
| 2 | Load test run at 2× expected peak; p99 < 500 ms; no connection pool exhaustion |
| 3 | Regression benchmarks in CI; auto-scaling tested; query plans reviewed for missing indexes |

Checks:
- Database queries have covering indexes for all filter columns.
- Redis cache used for hot read paths (score lookups, subscription metadata).
- External RPC calls have timeouts ≤ 10 seconds.
- Connection pool size documented and bounded.

---

## Dimension 8 — Rollback & Rollout

**Weight:** 2

| Score | Evidence expected |
|-------|-----------------|
| 0 | No rollback plan |
| 1 | Rollback documented but untested |
| 2 | Feature flag or staged rollout available; `migrate:down` tested on a staging snapshot |
| 3 | Canary deployment pipeline; automated rollback on error-rate spike |

Checks:
- Database migrations have a `down` step that returns to the previous schema.
- New API endpoints behind a feature flag until validated.
- Deployment runbook references this rubric's rollout steps.

---

## Dimension 9 — Documentation

**Weight:** 2

| Score | Evidence expected |
|-------|-----------------|
| 0 | No documentation |
| 1 | README updated; no API or data-model docs |
| 2 | API reference updated (Swagger / `docs/api-reference.md`); data model changes reflected in `docs/DATABASE.md`; env vars added to `docs/ENVIRONMENT.md` |
| 3 | Architecture decision record (ADR) filed; data lineage updated in `docs/data-lineage.md` if score inputs changed |

---

## Dimension 10 — On-Call Readiness

**Weight:** 2

| Score | Evidence expected |
|-------|-----------------|
| 0 | No runbook; no escalation path |
| 1 | Runbook stub exists |
| 2 | Runbook covers the top 3 failure modes with step-by-step recovery instructions; links to logs and dashboards |
| 3 | Runbook tested in a game day or staging drill; runbook linked from alert annotations |

Reference runbooks: [`docs/runbooks/`](runbooks/README.md).

---

## Dimension 11 — Migration & Schema Safety

**Weight:** 2

| Score | Evidence expected |
|-------|-----------------|
| 0 | Migrations not reviewed; breaking changes not assessed |
| 1 | Migrations reviewed but not tested against production data shape |
| 2 | Migrations are backward-compatible (additive only, no destructive renames in a single step); tested on a production snapshot |
| 3 | Zero-downtime migration path documented; rename-then-drop strategy used for column renames |

---

## Dimension 12 — Dependency Health

**Weight:** 1

| Score | Evidence expected |
|-------|-----------------|
| 0 | Dependencies not pinned; critical CVEs present |
| 1 | Dependencies pinned; CVEs present but not critical |
| 2 | No critical or high CVEs; Dependabot enabled |
| 3 | SBOM generated; dependencies reviewed for supply-chain risk |

---

## Dimension 13 — Financial Arithmetic

**Weight:** 3 (for any code that handles XLM / stroup amounts)

Skip this dimension (mark N/A) for integrations with no financial calculations.

| Score | Evidence expected |
|-------|-----------------|
| 0 | Floating-point used for money |
| 1 | BigInt or integer used in places but inconsistently |
| 2 | All amounts in stroops (integer); conversion to XLM only at display layer; property tests pass |
| 3 | Money type from `contracts/money` used throughout; overflow/underflow cases tested; fuzz tests green |

---

## Scorecard Template

```markdown
## Production Readiness Scorecard — <Integration Name>

| # | Dimension | Score (0–3) | Evidence / Notes |
|---|-----------|-------------|-----------------|
| 1 | Correctness & Validation | | |
| 2 | Authorization & Authentication | | |
| 3 | Failure & Retry Behaviour | | |
| 4 | Observability | | |
| 5 | Data Integrity | | |
| 6 | Security | | |
| 7 | Performance & Scalability | | |
| 8 | Rollback & Rollout | | |
| 9 | Documentation | | |
| 10 | On-Call Readiness | | |
| 11 | Migration & Schema Safety | | |
| 12 | Dependency Health | | |
| 13 | Financial Arithmetic | N/A or score | |

**Total: __ / 39** (N/A dimensions excluded from denominator)

**Threshold: 32 / 39** — ✅ PASS / ❌ FAIL

### Remediation items (if failed)
- [ ] Dim X: <action> — owner: @handle — due: YYYY-MM-DD

### Reviewer sign-off
Reviewed by: @handle — YYYY-MM-DD
```

---

## Threat Model Notes

| Threat | Relevant Dimension |
|--------|--------------------|
| Unauthenticated access to financial endpoints | 2 |
| Duplicate event processing causing double-disbursement | 3, 5 |
| Financial arithmetic rounding errors | 13 |
| Data exfiltration via unvalidated query parameters | 1, 6 |
| Deployment failure leaving schema in inconsistent state | 8, 11 |
| Stale score used for loan approval decision | 5 |
| Third-party dependency compromise | 12 |

---

## Rollout Steps

1. Complete the scorecard before merging to `main`.
2. If total score < 32, file remediation issues and obtain team lead approval
   for an exception with a time-bound remediation commitment.
3. Deploy to staging and run the relevant CI pipeline
   (`npm test`, `npm run lint`, Rust `cargo test`) before production.
4. Monitor Dimension 4 (observability) metrics for 24 hours after go-live.
5. Re-score at 30 days to validate that remediation items have been closed.
