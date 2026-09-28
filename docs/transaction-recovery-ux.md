# Transaction Recovery UX

How RemitLend recovers a borrower from a **rejected**, **expired** or **stalled** transaction, and the rules contributors must follow when changing a wallet-connected flow.

Addresses issue [#321](https://github.com/JhayJ22/remitlend/issues/321).

---

## 1. The problem this solves

A borrower who declines a signature, whose signed envelope expires while the wallet extension is closed, or whose confirmation never arrives used to land on a red "Transaction failed" box with a **Retry** button.

That was wrong in two ways:

1. **It blamed the user for their own decision.** A deliberate decline was presented as a system failure.
2. **The Retry button could create a second loan.** Once a signed transaction has been handed to the network, the outcome is *unknown*, not *failed*. Retrying blindly is how a borrower ends up borrowed twice. This is a direct financial-loss path, not a cosmetic bug.

## 2. The three questions every failure screen must answer

1. **What actually happened?** — rejected, expired, failed, or unknown.
2. **Is it safe to try again?** — and if not, why not.
3. **What is the single next safe action?**

---

## 3. The planner

`frontend/src/app/utils/transactionRecovery.ts` — a pure function of `(error, submission context)`. No I/O, no throws.

```ts
const plan = planTransactionRecovery(error, { txHash, submitted });

plan.state             // "rejected" | "expired" | "failed" | "unknown"
plan.safeToResubmit    // false once anything was submitted
plan.resubmitWarning   // null, or an explicit duplicate-loan warning
plan.steps             // ordered, plain-language guidance
plan.actions           // one button per safe next action
plan.supportCode       // non-identifying correlation code
```

`planRecoveryFromDetails(details, context)` is the same planner for callers that already ran `mapTransactionError` (for example after polling), so the message is not re-derived from a lossy string.

### Failure states

| State | Cause | Primary action |
|---|---|---|
| `rejected` | The borrower declined in the wallet. | **Sign again** — nothing was signed or sent. |
| `expired` | The signed envelope or the auth challenge expired. | **Sign again** + **Reload** — the dead envelope cannot be submitted. |
| `failed` | Simulation, on-chain or balance failure. | **Start over** only when `retryable`. |
| `unknown` | Unrecognised error. | **Start over** + **Reload**, conservatively. |

### Double-submission safety — the core invariant

> **Once a transaction has been submitted, no action in the plan can create a new one.**

`alreadySubmitted` is true when `submitted === true` **or** a `txHash` is present. In that case the plan is:

| Action | Kind | Rationale |
|---|---|---|
| `resume_tracking` | **primary** | Re-checks the *same* hash. Sends nothing. |
| `check_explorer` | secondary | Independent read of the final status. |
| `copy_tx_hash` | secondary | Preserves evidence for support and audit. |
| `reload_page` | secondary | Recovers the latest server state. |
| `contact_support` | secondary | With the support code. |

`resubmitWarning` renders in plain language: *"A transaction (`a1b2c3d4…`) may already be on chain. Do not submit a new one until you have checked its status — a second request can create a duplicate loan."*

Every action carries `requiresSignature`, and the panel tells the borrower that any action starting a new transaction will ask the wallet to sign again.

### Support code

`createRecoverySupportCode(category, txHash, attempt)` produces e.g. `NETWORK_TIMEOUT-A1B2C3D4-02`. It contains **only** the failure category, the first 8 characters of the transaction hash and a bounded attempt counter — never a wallet address, an amount, or any user input.

---

## 4. Resilient status polling

`pollTransactionStatus` (`frontend/src/app/utils/transactionErrors.ts`) was hardened in the same change:

| Change | Why |
|---|---|
| Every `fetch` receives an `AbortSignal` and a per-request timeout (10 s). | A hung Horizon call previously never returned, so neither the abort signal nor the overall timeout could take effect. |
| The sleep between attempts is abort-aware. | Cancelling used to wait out the full interval. |
| `maxAttempts` (default 240). | Bounds lookups independently of the wall clock, so a fast-failing endpoint cannot be hammered. |
| `dependencyFailure` on the result. | Distinguishes "Horizon is unreachable" from "the transaction failed". The UI can then say the outcome is *unknown* rather than claiming a failure. |
| `sleep` injection point. | Tests do not depend on wall-clock timers. |
| Abort is reported as `cancelled`, not as a network error. | The borrower chose it. |

The result type gained `attempts` and `dependencyFailure`. Both are additive; every existing success/failed/timeout/cancelled branch keeps its previous meaning.

`StepFinalSignature` keeps the submitted hash and loan id in refs, so **Resume tracking** re-polls the original transaction instead of starting a new one.

---

## 5. The panel

`frontend/src/app/components/transaction/TransactionRecoveryPanel.tsx`

- `role="alert"` with `aria-live="polite"`, a state badge, the headline, and the summary.
- The duplicate-submission warning when `safeToResubmit === false`.
- Ordered `<ol>` recovery steps.
- One button per action; `check_explorer` renders as a real anchor with `rel="noopener noreferrer"` so it works without JavaScript handlers.
- `copy_tx_hash` writes to the clipboard and reports "Copied"; a denied clipboard permission is swallowed and the hash stays on screen.
- Actions that need a hash (`check_explorer`, `copy_tx_hash`) are not rendered when there is no hash.
- The host owns every side effect via `onAction(actionId)`, which keeps the component pure and testable.

### Wiring

| Flow | Behaviour |
|---|---|
| `StepFinalSignature` | Tracks the submitted hash. A tracking failure produces a plan that leads with "Check status again"; only flows that never reached the network offer "Start over". |
| `repay/[loanId]` | Same planner; `retry_signing`/`resubmit` reset the form, `reload_page` reloads, `contact_support` opens a new issue with the code. |

---

## 6. Failure handling matrix

| Failure | Detection | User sees | Safe to resubmit |
|---|---|---|---|
| Declined in wallet | `rejected \| denied \| cancelled` | "You declined this request" + steps | Yes |
| Envelope / challenge expired | `expired \| expiration` | "This request expired" + "start a fresh request" | Yes |
| Network / RPC timeout during signing | `timeout \| network \| failed to fetch` | Retry + reload | Yes |
| Horizon unreachable while tracking | `dependencyFailure` | "Could not reach the network to confirm this transaction" | **No** — tracking offered |
| Still pending at timeout | `status === "timeout"` | Same as above, explicitly *pending* | **No** — tracking offered |
| On-chain failure | `failed on-chain \| tx failed \| revert` | No automatic retry | Yes, but not offered automatically |
| Insufficient balance | `insufficient` + `balance\|fund` | Reconnect-wallet path, no retry | Yes, but not offered automatically |
| Score too low | `score too low` | Eligibility guidance | Yes, but not offered automatically |
| Simulation failure | `simulation \| host error` | Retry after reviewing inputs | Yes |

---

## 7. Observability

- **Structured errors.** Every failure is classified into a typed category before it reaches the UI; raw provider strings never reach the borrower.
- **Audit trail.** `preserveTxHash` is set whenever a transaction may exist on chain, so the hash is retained for support and audit rather than discarded with the component.
- **Support correlation.** `supportCode` is deterministic and non-identifying, so a support ticket can be tied to a failure class without exposing user data.
- **Diagnostics.** `pollTransactionStatus` reports `attempts` and `dependencyFailure`; an unreachable Horizon and a settled failure are distinguishable in telemetry and in the UI.

See [Error Tracking](frontend/error-tracking.md) for the Sentry conventions this integrates with, and [Toasts](frontend/toasts.md) for the transient-error surface.

## 8. Threat model notes

| Threat | Mitigation |
|---|---|
| **Duplicate loan from blind retry** (the material one) | `safeToResubmit` is false as soon as anything was submitted; the plan contains no signature-requiring action; the UI states the duplicate risk explicitly. |
| **Denial of service via polling** | `maxAttempts` and a per-request timeout bound every loop; the sleep is abort-aware. |
| **Misleading status** | A dependency failure is never reported as a failed transaction; the outcome is described as unknown. |
| **PII leakage into diagnostics** | The support code contains a category, an 8-character hash prefix and an attempt counter. No addresses, amounts or free text. |
| **Unbounded clipboard / navigation side effects** | The panel only copies a hash it was given, and `noopener,noreferrer` is applied to the explorer link. |

## 9. Rollout and rollback

Additive: two new modules, two new components, and opt-in wiring in two flows. No API, contract or persisted-data change, and no migration. Rollback is a deploy revert; the only behavioural change is that a previously-redundant Retry button no longer appears in states where a transaction may already be on chain.

## 10. Testing

```bash
cd frontend
npx jest src/app/utils/transactionRecovery.test.ts
npx jest src/app/utils/transactionErrors.test.ts
npx jest src/app/components/transaction/__tests__/TransactionRecoveryPanel.test.tsx
```

- `transactionRecovery.test.ts` — every failure state, the double-submission invariant (including "no action requires a signature after submission"), the no-hash path, non-`Error` inputs, and the support code's bounds.
- `transactionErrors.test.ts` — the new `expired` category and its precedence, plus polling: success, failure, pending-then-success, attempt cap, wall-clock timeout, dependency failure, pre-abort, mid-poll abort, and the `AbortSignal` passed to `fetch`.
- `TransactionRecoveryPanel.test.tsx` — rendering per state, the duplicate warning, absence of re-sign actions after submission, the explorer `href`/`rel`, clipboard success and denial, the busy state, and rendering with no handler.

## 11. Related documentation

- [Wallet Transaction UX](wallet-transaction-ux.md) — the signing and polling rules these components implement.
- [Loan Cost Disclosure](loan-cost-disclosure.md) — what the borrower is signing.
- [Security Model](SECURITY-MODEL.md)
