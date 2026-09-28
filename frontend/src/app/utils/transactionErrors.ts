export type TransactionErrorCategory =
  | "wallet_rejected"
  | "expired"
  | "network_timeout"
  | "insufficient_balance"
  | "score_too_low"
  | "onchain_failure"
  | "simulation_failed"
  | "unknown";

export interface TransactionErrorDetails {
  category: TransactionErrorCategory;
  title: string;
  message: string;
  guidance: string;
  retryable: boolean;
  cancelledByUser: boolean;
}

export interface PollTransactionOptions {
  horizonUrl?: string;
  intervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Maximum number of horizon lookups. Bounds resource usage independently of
   * the wall-clock timeout so a fast-failing endpoint cannot be hammered.
   */
  maxAttempts?: number;
  /**
   * Per-request timeout in milliseconds. A hung fetch is aborted so the
   * overall `timeoutMs` budget and the abort signal stay authoritative.
   */
  requestTimeoutMs?: number;
  /** Injectable sleep so tests do not depend on wall-clock timers. */
  sleep?: (ms: number) => Promise<void>;
}

export interface PollTransactionResult {
  status: "success" | "failed" | "timeout" | "cancelled";
  message: string;
  /** Number of horizon lookups performed before returning. */
  attempts: number;
  /** True when the status could not be determined because Horizon was unusable. */
  dependencyFailure: boolean;
}

/**
 * Frontend message mapping for backend ErrorCodes.
 * Ensured in sync with backend/src/errors/errorCodes.ts via CI check script.
 */
export const ERROR_CODE_MESSAGES: Record<string, string> = {
  INVALID_AMOUNT: "Amount must be a positive number",
  INVALID_PUBLIC_KEY: "Invalid Stellar public key",
  INVALID_SIGNATURE: "Invalid cryptographic signature",
  INVALID_CHALLENGE: "Invalid challenge format",
  MISSING_FIELD: "Required field is missing",
  VALIDATION_ERROR: "Validation failed",
  UNAUTHORIZED: "Unauthorized access",
  TOKEN_EXPIRED: "Session token has expired",
  TOKEN_INVALID: "Invalid session token",
  CHALLENGE_EXPIRED: "Authentication challenge has expired",
  FORBIDDEN: "Forbidden access",
  ACCESS_DENIED: "Access to resource denied",
  NOT_FOUND: "Resource not found",
  LOAN_NOT_FOUND: "Loan not found",
  USER_NOT_FOUND: "User account not found",
  POOL_NOT_FOUND: "Lending pool not found",
  CONFLICT: "Resource conflict occurred",
  DUPLICATE_REQUEST: "Duplicate request ignored",
  RATE_LIMIT_EXCEEDED: "Rate limit exceeded. Please wait",
  INTERNAL_ERROR: "Internal server error occurred",
  DATABASE_ERROR: "Database error occurred",
  EXTERNAL_SERVICE_ERROR: "External service error occurred",
  BLOCKCHAIN_ERROR: "Blockchain operation failed",
  BORROWER_MISMATCH: "Borrower wallet mismatch",
  INSUFFICIENT_BALANCE: "Insufficient account balance",
  LOAN_ALREADY_REPAID: "Loan has already been repaid",
  LOAN_NOT_ACTIVE: "Loan is not active",
  INVALID_LOAN_ID: "Invalid loan ID provided",
  INVALID_TX_XDR: "Invalid transaction XDR format",
};

const DEFAULT_HORIZON_URL = "https://horizon-testnet.stellar.org";

/** Hard ceiling on horizon lookups, applied when the caller sets no limit. */
const DEFAULT_MAX_POLL_ATTEMPTS = 240;

/** Per-request ceiling; keeps one slow Horizon call from consuming the budget. */
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    // `JSON.stringify` returns `undefined` (not a string) for `undefined`,
    // functions and symbols, so normalise before returning.
    return JSON.stringify(error) ?? String(error);
  } catch {
    return "Unknown transaction error";
  }
}

export function mapTransactionError(error: unknown): TransactionErrorDetails {
  const rawMessage = toErrorMessage(error);
  const normalized = rawMessage.toLowerCase();

  if (
    normalized.includes("rejected") ||
    normalized.includes("denied") ||
    normalized.includes("cancelled") ||
    normalized.includes("canceled")
  ) {
    return {
      category: "wallet_rejected",
      title: "Transaction cancelled",
      message: "You cancelled the signing request in your wallet.",
      guidance: "No funds moved. You can review details and submit again when ready.",
      retryable: true,
      cancelledByUser: true,
    };
  }

  if (
    normalized.includes("expired") ||
    normalized.includes("expiration") ||
    normalized.includes("expiredsequence") ||
    normalized.includes("has expired")
  ) {
    return {
      category: "expired",
      title: "Request expired",
      message: "This request or session expired before it could be completed.",
      guidance: "Start a fresh request — nothing was charged to your account.",
      retryable: true,
      cancelledByUser: false,
    };
  }

  if (
    normalized.includes("timeout") ||
    normalized.includes("network") ||
    normalized.includes("failed to fetch")
  ) {
    return {
      category: "network_timeout",
      title: "Network issue",
      message: "The network request timed out or could not be completed.",
      guidance: "Check connectivity and retry. If it keeps failing, try again in a few minutes.",
      retryable: true,
      cancelledByUser: false,
    };
  }

  if (
    normalized.includes("insufficient") &&
    (normalized.includes("balance") || normalized.includes("fund"))
  ) {
    return {
      category: "insufficient_balance",
      title: "Insufficient balance",
      message: "Your available balance is too low for this transaction.",
      guidance: "Reduce the amount or fund your wallet, then try again.",
      retryable: false,
      cancelledByUser: false,
    };
  }

  if (
    normalized.includes("score too low") ||
    normalized.includes("insufficient score") ||
    normalized.includes("insufficientscore")
  ) {
    return {
      category: "score_too_low",
      title: "Loan request not eligible",
      message: "Your credit score does not meet the minimum requirement.",
      guidance: "Repay active loans on time and retry after your score improves.",
      retryable: false,
      cancelledByUser: false,
    };
  }

  if (normalized.includes("simulation") || normalized.includes("host error")) {
    return {
      category: "simulation_failed",
      title: "Simulation failed",
      message: "The contract simulation failed before submission.",
      guidance: "Review your values and wallet state, then retry.",
      retryable: true,
      cancelledByUser: false,
    };
  }

  if (
    normalized.includes("failed on-chain") ||
    normalized.includes("tx failed") ||
    normalized.includes("revert")
  ) {
    return {
      category: "onchain_failure",
      title: "Transaction failed on-chain",
      message: "The transaction was submitted but did not succeed on-chain.",
      guidance: "Check the transaction hash details and adjust inputs before retrying.",
      retryable: false,
      cancelledByUser: false,
    };
  }

  return {
    category: "unknown",
    title: "Transaction failed",
    message: rawMessage,
    guidance: "Try again, or adjust the amount and wallet state before retrying.",
    retryable: true,
    cancelledByUser: false,
  };
}

async function fetchTransactionStatus(
  txHash: string,
  horizonUrl: string,
  { requestTimeoutMs, signal }: { requestTimeoutMs: number; signal?: AbortSignal },
): Promise<
  { status: "pending" | "success" | "failed" } | { status: "aborted" } | { status: "unreachable" }
> {
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  signal?.addEventListener("abort", onOuterAbort, { once: true });
  const timer =
    requestTimeoutMs > 0 ? setTimeout(() => controller.abort(), requestTimeoutMs) : undefined;

  try {
    const response = await fetch(`${horizonUrl}/transactions/${txHash}`, {
      signal: controller.signal,
    });

    if (response.status === 404) {
      return { status: "pending" };
    }

    if (!response.ok) {
      return { status: "unreachable" };
    }

    const payload = (await response.json()) as { successful?: boolean };
    return { status: payload.successful ? "success" : "failed" };
  } catch {
    // Distinguish "the user aborted" from "Horizon is unreachable" so the
    // caller can offer a cancel path rather than a network error.
    if (signal?.aborted) {
      return { status: "aborted" };
    }
    return { status: "unreachable" };
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", onOuterAbort);
  }
}

export async function pollTransactionStatus(
  txHash: string,
  {
    horizonUrl = process.env.NEXT_PUBLIC_HORIZON_URL ?? DEFAULT_HORIZON_URL,
    intervalMs = 2500,
    timeoutMs = 30_000,
    maxAttempts = DEFAULT_MAX_POLL_ATTEMPTS,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    sleep,
    signal,
  }: PollTransactionOptions = {},
): Promise<PollTransactionResult> {
  const startedAt = Date.now();
  const attemptLimit = Number.isFinite(maxAttempts) && maxAttempts > 0 ? maxAttempts : 1;
  let attempts = 0;
  let dependencyFailure = false;

  while (Date.now() - startedAt < timeoutMs && attempts < attemptLimit) {
    if (signal?.aborted) {
      return {
        status: "cancelled",
        message: "Status tracking cancelled by user.",
        attempts,
        dependencyFailure,
      };
    }

    attempts += 1;
    const outcome = await fetchTransactionStatus(txHash, horizonUrl, { requestTimeoutMs, signal });

    if (outcome.status === "aborted") {
      return {
        status: "cancelled",
        message: "Status tracking cancelled by user.",
        attempts,
        dependencyFailure,
      };
    }

    if (outcome.status === "success") {
      return {
        status: "success",
        message: "Transaction confirmed on-chain.",
        attempts,
        dependencyFailure,
      };
    }

    if (outcome.status === "failed") {
      return {
        status: "failed",
        message: "Transaction failed on-chain.",
        attempts,
        dependencyFailure,
      };
    }

    if (outcome.status === "unreachable") {
      // Horizon could not answer. Keep polling within the remaining budget,
      // but remember it so the UI can say the outcome is unknown rather than
      // claiming the transaction failed.
      dependencyFailure = true;
    }

    await (sleep ? sleep(intervalMs) : defaultSleep(intervalMs, signal));
  }

  if (dependencyFailure) {
    return {
      status: "timeout",
      message: "Could not reach the network to confirm this transaction.",
      attempts,
      dependencyFailure: true,
    };
  }

  return {
    status: "timeout",
    message: "Transaction is still pending. You can retry status tracking.",
    attempts,
    dependencyFailure,
  };
}
