# NNNN — Title (imperative, present tense)

**Date:** YYYY-MM-DD  
**Status:** Proposed | Accepted | Deprecated | Superseded by [NNNN](./NNNN-title.md)  
**Deciders:** @handle1, @handle2  
**Related issues:** #NNN

---

## Context

<!--
Describe the situation or problem that motivated this decision.
Include the constraints that were in play (performance, security, on-chain costs,
regulatory, etc.).  Be specific about which layers are affected.
-->

---

## Decision

<!--
State the decision clearly and concisely.
"We will …" or "We decided to …"
-->

---

## Consequences

### Positive

<!--
List the benefits: improved correctness, reduced complexity, safer upgrades, etc.
-->

### Negative / trade-offs

<!--
List known downsides, risks, or things that become harder.
-->

### Neutral

<!--
Side-effects that are neither clearly good nor bad.
-->

---

## Financial arithmetic impact

<!--
Required for any change that touches money calculations.
-->

| Aspect | Before | After | Verified by |
|---|---|---|---|
| Rounding mode | | | |
| Precision (stroops / bps) | | | |
| Overflow guard | | | |
| Fuzz coverage | | | |

---

## Cross-layer compatibility

<!--
Fill in each row even if there is no change in that layer — "no change" is
still useful information.
-->

| Layer | Impact | Migration required? |
|---|---|---|
| Soroban contracts | | |
| Backend API | | |
| Frontend | | |
| Database schema | | |
| Environment variables | | |

---

## Rollout steps

<!--
Step-by-step instructions for deploying this change safely.
Include any on-chain governance proposal steps, migration scripts, or feature
flags that need to be toggled.
-->

1. …
2. …
3. …

---

## Rollback plan

<!--
How to undo this change if it turns out to be wrong.
For on-chain changes, this typically means: submit a governance proposal with
the previous values, collect quorum, wait for timelock, execute.
-->

---

## Threat model notes

<!--
Any security or trust implications.  Who could abuse this change?  What is the
worst-case blast radius if a signer is compromised?
-->

---

## Verification evidence

<!--
Link to test results, CI runs, or before/after measurements that confirm the
decision was implemented correctly.
-->

- [ ] Unit tests pass (`cargo test` / `npm test`)
- [ ] Type checks pass (`tsc --noEmit` / `cargo check`)
- [ ] Linting passes (`npm run lint` / `cargo clippy`)
- [ ] Integration tests pass (where applicable)
- [ ] Governance proposal ID recorded: _________________
