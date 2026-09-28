/**
 * transactionRecovery.ts
 *
 * Recovery planning for rejected and expired transactions (issue #321).
 *
 * A borrower who rejects a signature, whose transaction envelope expires while
 * the wallet extension is closed, or whose confirmation never arrives is not
 * facing a "transaction failed" screen. They need to know three things:
 *
 *   1. What actually happened, in plain language.
 *   2. Whether it is safe to try again — a transaction that was already
 *      submitted must never be silently resubmitted, because that creates a
 *      duplicate loan and a real financial loss for the borrower.
 *   3. The single next action that is safe to take.
 *
 * This module is a pure function of (error, submission context). It performs
 * no I/O, throws nothing, and returns a plan that a view can render directly.
 * It is additive: no API, contract or persisted-data shape changes.
 */

import { mapTransactionError, type TransactionErrorDetails } from "./transactionErrors";

/** How the flow ended, from the borrower's point of view. */
export type TransactionFailureState = "rejected" | "expired" | "failed" | "unknown";

export type RecoveryActionId =
  | "retry_signing"
  | "resubmit"
  | "resume_tracking"
  | "check_explorer"
  | "copy_tx_hash"
  | "reconnect_wallet"
  | "reload_page"
  | "contact_support";

export interface RecoveryAction {
  id: RecoveryActionId;
  label: string;
  description: string;
  /** Primary actions are rendered first and are the recommended next step. */
  variant: "primary" | "secondary";
  /**
   * True when running the action can put a *new* transaction on chain, and
   * therefore requires a fresh wallet signature. The UI must label these.
   */
  requiresSignature: boolean;
}

export interface TransactionRecoveryContext {
  /** Hash of the submitted transaction, when one exists. */
  txHash?: string | null;
  /**
   * True once a signed transaction has been handed to the network. When true,
   * the flow must never offer blind resubmission.
   */
  submitted?: boolean;
  /** Which flow the plan is for; used in diagnostics only. */
  flow?: string;
}

export interface TransactionRecoveryPlan {
  state: TransactionFailureState;
  category: TransactionErrorDetails["category"];
  headline: string;
  summary: string;
  /** Ordered, numbered guidance the borrower can follow. */
  steps: string[];
  actions: RecoveryAction[];
  /**
   * Whether starting the flow over is safe. False means a transaction may
   * already exist on chain.
   */
  safeToResubmit: boolean;
  /** Populated when `safeToResubmit` is false. */
  resubmitWarning: string | null;
  /** Whether the tx hash must be preserved for support/audit. */
  preserveTxHash: boolean;
  /** Non-identifying correlation code for support tickets. */
  supportCode: string;
}

const RETRY_SIGNING: RecoveryAction = {
  id: "retry_signing",
  label: "Sign again",
  description: "Reopen your wallet and approve the same request. Nothing was charged.",
  variant: "primary",
  requiresSignature: true,
};

const RESUBMIT: RecoveryAction = {
  id: "resubmit",
  label: "Start over",
  description: "Build and sign a fresh request. Use this only if no transaction was sent.",
  variant: "primary",
  requiresSignature: true,
};

const RESUME_TRACKING: RecoveryAction = {
  id: "resume_tracking",
  label: "Check status again",
  description: "Look up the same transaction hash. This does not send anything.",
  variant: "primary",
  requiresSignature: false,
};

const CHECK_EXPLORER: RecoveryAction = {
  id: "check_explorer",
  label: "View on explorer",
  description: "Open the transaction in a block explorer to inspect its final status.",
  variant: "secondary",
  requiresSignature: false,
};

const COPY_TX_HASH: RecoveryAction = {
  id: "copy_tx_hash",
  label: "Copy transaction ID",
  description: "Copy the transaction hash so support can trace it.",
  variant: "secondary",
  requiresSignature: false,
};

const RECONNECT_WALLET: RecoveryAction = {
  id: "reconnect_wallet",
  label: "Reconnect wallet",
  description: "Reconnect the wallet extension, then repeat the request.",
  variant: "secondary",
  requiresSignature: true,
};

const RELOAD_PAGE: RecoveryAction = {
  id: "reload_page",
  label: "Reload this page",
  description: "Reload to recover the latest server state before trying again.",
  variant: "secondary",
  requiresSignature: false,
};

const CONTACT_SUPPORT: RecoveryAction = {
  id: "contact_support",
  label: "Contact support",
  description: "Include the support code below so the transaction can be traced.",
  variant: "secondary",
  requiresSignature: false,
};

/**
 * Build a short, non-identifying support code. It encodes only the failure
 * category, a truncated transaction hash and the attempt count — never a
 * wallet address, amount, or any user input.
 */
export function createRecoverySupportCode(
  category: string,
  txHash?: string | null,
  attempt = 1,
): string {
  const hashPart = txHash ? txHash.slice(0, 8).toUpperCase() : "NOHASH";
  const boundedAttempt = Number.isFinite(attempt) && attempt > 0 ? Math.min(attempt, 999) : 1;
  return `${category.toUpperCase().slice(0, 16)}-${hashPart}-${String(boundedAttempt).padStart(2, "0")}`;
}

function duplicateRiskWarning(txHash?: string | null): string {
  return txHash
    ? `A transaction (${txHash.slice(0, 8)}…) may already be on chain. Do not submit a new one until you have checked its status — a second request can create a duplicate loan.`
    : "A transaction may already be on chain. Check the activity list before submitting a new request, so you are not borrowed twice.";
}

function withSupportCode(steps: string[], supportCode: string): string[] {
  return [...steps, `Quote support code ${supportCode} if you need help.`];
}

/**
 * Derive a recovery plan from a raw error plus what we know about the flow.
 *
 * Never throws: an unrecognised error still yields a usable, conservative plan
 * (retry allowed only when nothing was submitted).
 */
export function planTransactionRecovery(
  error: unknown,
  context: TransactionRecoveryContext = {},
): TransactionRecoveryPlan {
  const details = mapTransactionError(error);
  const { txHash = null, submitted = false } = context;
  const alreadySubmitted = submitted || Boolean(txHash);
  const supportCode = createRecoverySupportCode(details.category, txHash);

  const state = resolveState(details);
  const safeToResubmit = !alreadySubmitted;

  return {
    state,
    category: details.category,
    headline: resolveHeadline(state, details),
    summary: details.message,
    steps: withSupportCode(resolveSteps(state, details, alreadySubmitted), supportCode),
    actions: resolveActions(state, details, { alreadySubmitted, txHash }),
    safeToResubmit,
    resubmitWarning: safeToResubmit ? null : duplicateRiskWarning(txHash),
    preserveTxHash: alreadySubmitted,
    supportCode,
  };
}

/**
 * Derive a plan from an already-mapped error. Used by callers that already ran
 * `mapTransactionError` (for example after polling) so the message is not
 * re-derived from a lossy string.
 */
export function planRecoveryFromDetails(
  details: TransactionErrorDetails,
  context: TransactionRecoveryContext = {},
): TransactionRecoveryPlan {
  const { txHash = null, submitted = false } = context;
  const alreadySubmitted = submitted || Boolean(txHash);
  const supportCode = createRecoverySupportCode(details.category, txHash);
  const state = resolveState(details);
  const safeToResubmit = !alreadySubmitted;

  return {
    state,
    category: details.category,
    headline: resolveHeadline(state, details),
    summary: details.message,
    steps: withSupportCode(resolveSteps(state, details, alreadySubmitted), supportCode),
    actions: resolveActions(state, details, { alreadySubmitted, txHash }),
    safeToResubmit,
    resubmitWarning: safeToResubmit ? null : duplicateRiskWarning(txHash),
    preserveTxHash: alreadySubmitted,
    supportCode,
  };
}

function resolveState(details: TransactionErrorDetails): TransactionFailureState {
  if (details.category === "wallet_rejected") return "rejected";
  if (details.category === "expired") return "expired";
  if (details.category === "unknown") return "unknown";
  return "failed";
}

function resolveHeadline(state: TransactionFailureState, details: TransactionErrorDetails): string {
  switch (state) {
    case "rejected":
      return "You declined this request";
    case "expired":
      return "This request expired";
    case "failed":
      return details.title;
    default:
      return details.title;
  }
}

function resolveSteps(
  state: TransactionFailureState,
  details: TransactionErrorDetails,
  alreadySubmitted: boolean,
): string[] {
  if (alreadySubmitted) {
    return [
      "Your transaction was sent to the network before this problem occurred.",
      `Check its status first — the outcome is not yet known. (${details.guidance})`,
      "Only start a new request if the original transaction is confirmed to have failed.",
    ];
  }

  switch (state) {
    case "rejected":
      return [
        "The wallet asked you to approve the transaction and you declined. Nothing was signed and nothing was sent.",
        `Review the details again when you are ready. (${details.guidance})`,
      ];
    case "expired":
      return [
        "A signed request or session can expire while the wallet is closed or while you are away.",
        "Start a fresh request; the expired one can no longer be submitted.",
        `Check the details before approving. (${details.guidance})`,
      ];
    case "failed":
      return [`${details.message}`, details.guidance];
    default:
      return [
        "We could not determine why the request stopped.",
        "Nothing was charged unless a transaction was confirmed on chain.",
        `Check your activity list, then try again. (${details.guidance})`,
      ];
  }
}

function resolveActions(
  state: TransactionFailureState,
  details: TransactionErrorDetails,
  { alreadySubmitted, txHash }: { alreadySubmitted: boolean; txHash: string | null },
): RecoveryAction[] {
  const actions: RecoveryAction[] = [];

  if (alreadySubmitted) {
    // Never lead with something that can create a second on-chain transaction.
    actions.push(RESUME_TRACKING);
    if (txHash) actions.push(CHECK_EXPLORER, COPY_TX_HASH);
    actions.push(RELOAD_PAGE, CONTACT_SUPPORT);
    return actions;
  }

  switch (state) {
    case "rejected":
      actions.push(RETRY_SIGNING);
      break;
    case "expired":
      actions.push(RETRY_SIGNING, RELOAD_PAGE);
      break;
    case "failed":
      if (details.retryable) {
        actions.push(RESUBMIT);
      }
      break;
    default:
      actions.push(RESUBMIT, RELOAD_PAGE);
      break;
  }

  if (details.category === "insufficient_balance") actions.push(RECONNECT_WALLET);
  actions.push(CONTACT_SUPPORT);
  return actions;
}

/** Exported for focused unit tests of the action catalogue. */
export const RECOVERY_ACTIONS: Readonly<Record<RecoveryActionId, RecoveryAction>> = {
  retry_signing: RETRY_SIGNING,
  resubmit: RESUBMIT,
  resume_tracking: RESUME_TRACKING,
  check_explorer: CHECK_EXPLORER,
  copy_tx_hash: COPY_TX_HASH,
  reconnect_wallet: RECONNECT_WALLET,
  reload_page: RELOAD_PAGE,
  contact_support: CONTACT_SUPPORT,
};
