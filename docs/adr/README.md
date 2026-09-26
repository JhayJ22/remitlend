# Architecture Decision Records (ADRs)

This directory contains Architecture Decision Records for RemitLend.  An ADR
captures the context, decision, and consequences of a significant technical
choice — especially any change that crosses the contract / backend / frontend
boundary or that affects financial arithmetic.

---

## Why ADRs?

RemitLend handles real money on an immutable ledger.  A change to an interest
calculation, a rounding rule, or a contract storage layout can silently break
three separate layers at once.  ADRs create a durable, reviewable record of
*why* a cross-layer decision was made so that future contributors can reason
about it without reconstructing context from git blame.

---

## Scope: when is an ADR required?

An ADR is **required** for any change that:

- Modifies financial arithmetic (interest, fees, rounding, currency conversion)
  in any layer (contract, backend, frontend)
- Changes a Soroban contract's public interface or storage layout
- Changes the API contract between backend and frontend in a
  backwards-incompatible way
- Adds or removes a network (testnet → mainnet, etc.)
- Changes the governance quorum, timelock, or signer set
- Deprecates or replaces a core algorithm (e.g., credit-score formula)

An ADR is **optional but encouraged** for:

- Significant library upgrades (`soroban-sdk`, `stellar-sdk`)
- New cron jobs or background workers that touch financial state
- Authentication or authorization model changes

---

## Process

1. **Copy the template**

   ```bash
   cp docs/adr/template.md docs/adr/NNNN-short-title.md
   ```

   Replace `NNNN` with the next sequential number (e.g., `0001`, `0002`).
   The title should be a short imperative phrase: `use-basis-points-for-interest`,
   `add-mainnet-deployment`.

2. **Fill in the template** — status starts as `Proposed`.

3. **Open a PR** — include the ADR file and any code changes in the same PR.
   Link the PR to the relevant GitHub issue.

4. **Review** — at least one maintainer must approve.  If the ADR touches
   on-chain state, a second review from someone familiar with Soroban is
   required.

5. **Merge** — update status to `Accepted` before merging.

6. **Supersession** — if an ADR is later replaced, update its status to
   `Superseded by [NNNN](./NNNN-new-title.md)` and add the link.

---

## Status values

| Status | Meaning |
|---|---|
| `Proposed` | Under active review, not yet merged |
| `Accepted` | Merged; the decision is in effect |
| `Deprecated` | No longer recommended; new code should not follow it |
| `Superseded` | Replaced by a newer ADR (link required) |

---

## Index of decisions

| # | Title | Status | Date |
|---|---|---|---|
| — | *(no ADRs recorded yet — open the first one!)* | — | — |

> Maintainers: update this table whenever a new ADR is merged.

---

## Template

See [`template.md`](./template.md) for the full ADR template.
