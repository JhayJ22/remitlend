/**
 * Schema-driven, localized error presentation for API error codes.
 *
 * Stable backend codes map to a guidance category. The category selects a
 * localized title/message/action from the `Errors` message namespace. Raw
 * server text is never rendered; machine codes and technical reference IDs
 * are displayed verbatim and are never translated.
 */

export type ErrorSeverity = "info" | "warning" | "error" | "critical";

export type ErrorAction = "retry" | "reauthenticate" | "contact_support" | "refresh" | "none";

export const ERROR_GUIDANCE_KEYS = [
  "invalidAmount",
  "invalidCredentials",
  "invalidInput",
  "sessionExpired",
  "accessDenied",
  "notFound",
  "conflict",
  "duplicateRequest",
  "rateLimited",
  "unavailable",
  "invalidLoan",
  "loanState",
  "insufficientFunds",
  "blockchain",
  "internal",
  "fallback",
] as const;

export type ErrorGuidanceKey = (typeof ERROR_GUIDANCE_KEYS)[number];

export interface ErrorPresentation {
  /** Stable machine code, or 'UNKNOWN' when the payload is unrecognized. */
  code: string;
  /** Legacy English message retained for non-localized consumers. */
  message: string;
  severity: ErrorSeverity;
  retryable: boolean;
  action: ErrorAction;
  retryAfterMs?: number;
  /** Localized-copy selector. Never derived from untrusted server text. */
  guidanceKey: ErrorGuidanceKey;
  /** Technical correlation ID shown verbatim so support can trace the request. */
  referenceId?: string;
}

export interface LocalizedErrorPresentation extends ErrorPresentation {
  title: string;
  guidance: string;
  actionLabel: string;
  referenceLabel: string;
}

interface ErrorSchemaEntry {
  message: string;
  severity: ErrorSeverity;
  retryable: boolean;
  action: ErrorAction;
  guidanceKey: ErrorGuidanceKey;
  retryAfterMs?: number;
}

const ERROR_SCHEMA: Record<string, ErrorSchemaEntry> = {
  INVALID_AMOUNT: {
    message: "Amount must be a positive number.",
    severity: "warning",
    retryable: false,
    action: "none",
    guidanceKey: "invalidAmount",
  },
  INVALID_PUBLIC_KEY: {
    message: "Invalid account identifier.",
    severity: "warning",
    retryable: false,
    action: "none",
    guidanceKey: "invalidCredentials",
  },
  INVALID_SIGNATURE: {
    message: "The wallet signature could not be verified.",
    severity: "warning",
    retryable: true,
    action: "retry",
    guidanceKey: "invalidCredentials",
    retryAfterMs: 1000,
  },
  INVALID_CHALLENGE: {
    message: "The sign-in challenge is not valid.",
    severity: "warning",
    retryable: true,
    action: "refresh",
    guidanceKey: "invalidCredentials",
  },
  INVALID_TX_XDR: {
    message: "The transaction payload could not be read.",
    severity: "warning",
    retryable: false,
    action: "none",
    guidanceKey: "invalidInput",
  },
  MISSING_FIELD: {
    message: "A required value is missing.",
    severity: "warning",
    retryable: false,
    action: "none",
    guidanceKey: "invalidInput",
  },
  VALIDATION_ERROR: {
    message: "Some of the provided information is invalid.",
    severity: "warning",
    retryable: false,
    action: "none",
    guidanceKey: "invalidInput",
  },
  UNAUTHORIZED: {
    message: "Sign in to continue.",
    severity: "warning",
    retryable: false,
    action: "reauthenticate",
    guidanceKey: "sessionExpired",
  },
  TOKEN_EXPIRED: {
    message: "Your session has expired.",
    severity: "warning",
    retryable: false,
    action: "reauthenticate",
    guidanceKey: "sessionExpired",
  },
  TOKEN_INVALID: {
    message: "Your session is no longer valid.",
    severity: "warning",
    retryable: false,
    action: "reauthenticate",
    guidanceKey: "sessionExpired",
  },
  CHALLENGE_EXPIRED: {
    message: "The sign-in challenge expired.",
    severity: "warning",
    retryable: true,
    action: "refresh",
    guidanceKey: "sessionExpired",
  },
  CHALLENGE_REPLAYED: {
    message: "The sign-in challenge was already used.",
    severity: "warning",
    retryable: true,
    action: "refresh",
    guidanceKey: "sessionExpired",
  },
  FORBIDDEN: {
    message: "You do not have access to this action.",
    severity: "error",
    retryable: false,
    action: "contact_support",
    guidanceKey: "accessDenied",
  },
  ACCESS_DENIED: {
    message: "Access to this resource was denied.",
    severity: "error",
    retryable: false,
    action: "contact_support",
    guidanceKey: "accessDenied",
  },
  NOT_FOUND: {
    message: "The requested resource could not be found.",
    severity: "warning",
    retryable: false,
    action: "refresh",
    guidanceKey: "notFound",
  },
  LOAN_NOT_FOUND: {
    message: "The requested loan could not be found.",
    severity: "warning",
    retryable: false,
    action: "refresh",
    guidanceKey: "invalidLoan",
  },
  USER_NOT_FOUND: {
    message: "The requested account could not be found.",
    severity: "warning",
    retryable: false,
    action: "refresh",
    guidanceKey: "notFound",
  },
  POOL_NOT_FOUND: {
    message: "The requested lending pool could not be found.",
    severity: "warning",
    retryable: false,
    action: "refresh",
    guidanceKey: "notFound",
  },
  CONFLICT: {
    message: "The current state changed before this action completed.",
    severity: "warning",
    retryable: true,
    action: "refresh",
    guidanceKey: "conflict",
    retryAfterMs: 1000,
  },
  DUPLICATE_REQUEST: {
    message: "This request was already accepted.",
    severity: "info",
    retryable: false,
    action: "refresh",
    guidanceKey: "duplicateRequest",
  },
  RATE_LIMIT_EXCEEDED: {
    message: "Too many requests were sent.",
    severity: "warning",
    retryable: true,
    action: "retry",
    guidanceKey: "rateLimited",
    retryAfterMs: 5000,
  },
  INTERNAL_ERROR: {
    message: "The request could not be completed.",
    severity: "critical",
    retryable: true,
    action: "contact_support",
    guidanceKey: "internal",
    retryAfterMs: 15000,
  },
  DATABASE_ERROR: {
    message: "Data could not be read right now.",
    severity: "error",
    retryable: true,
    action: "retry",
    guidanceKey: "unavailable",
    retryAfterMs: 10000,
  },
  EXTERNAL_SERVICE_ERROR: {
    message: "A connected service is unavailable.",
    severity: "error",
    retryable: true,
    action: "retry",
    guidanceKey: "unavailable",
    retryAfterMs: 10000,
  },
  BLOCKCHAIN_ERROR: {
    message: "The network operation could not be completed.",
    severity: "error",
    retryable: true,
    action: "retry",
    guidanceKey: "blockchain",
    retryAfterMs: 5000,
  },
  SERVICE_UNAVAILABLE: {
    message: "The service is temporarily unavailable.",
    severity: "error",
    retryable: true,
    action: "retry",
    guidanceKey: "unavailable",
    retryAfterMs: 10000,
  },
  SERVICE_OVERLOADED: {
    message: "The service is busy right now.",
    severity: "warning",
    retryable: true,
    action: "retry",
    guidanceKey: "rateLimited",
    retryAfterMs: 5000,
  },
  BORROWER_MISMATCH: {
    message: "This loan belongs to a different wallet.",
    severity: "error",
    retryable: false,
    action: "none",
    guidanceKey: "loanState",
  },
  INSUFFICIENT_BALANCE: {
    message: "The account balance is too low.",
    severity: "warning",
    retryable: true,
    action: "refresh",
    guidanceKey: "insufficientFunds",
  },
  LOAN_ALREADY_REPAID: {
    message: "This loan has already been repaid.",
    severity: "info",
    retryable: false,
    action: "refresh",
    guidanceKey: "loanState",
  },
  LOAN_NOT_ACTIVE: {
    message: "This loan is not active.",
    severity: "warning",
    retryable: false,
    action: "refresh",
    guidanceKey: "loanState",
  },
  INVALID_LOAN_ID: {
    message: "The loan identifier is not valid.",
    severity: "warning",
    retryable: false,
    action: "none",
    guidanceKey: "invalidLoan",
  },
};

/** Stable backend codes with an explicit presentation mapping. */
export const SUPPORTED_ERROR_CODES = Object.keys(ERROR_SCHEMA).sort();

/** Guidance category used by a stable backend code, or null when unmapped. */
export function guidanceKeyForCode(code: string): ErrorGuidanceKey | null {
  return ERROR_SCHEMA[code]?.guidanceKey ?? null;
}

const FALLBACK: ErrorPresentation = {
  code: "UNKNOWN",
  message: "An unexpected error occurred. Please try again.",
  severity: "error",
  retryable: false,
  action: "none",
  guidanceKey: "fallback",
};

const MAX_CODE_LENGTH = 64;
const CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const MAX_REFERENCE_LENGTH = 64;
const REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function normalizeCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.trim();
  if (code.length === 0 || code.length > MAX_CODE_LENGTH) return null;
  return CODE_PATTERN.test(code) ? code : null;
}

function normalizeReference(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const reference = raw.trim();
  if (reference.length === 0 || reference.length > MAX_REFERENCE_LENGTH) return null;
  return REFERENCE_PATTERN.test(reference) ? reference : null;
}

function payloadObjects(payload: unknown): Record<string, unknown>[] {
  if (!payload || typeof payload !== "object") return [];
  const root = payload as Record<string, unknown>;
  const objects = [root];
  for (const key of ["error", "details", "response"]) {
    const value = root[key];
    if (value && typeof value === "object") objects.push(value as Record<string, unknown>);
  }
  const data = root.response;
  if (data && typeof data === "object") {
    const dataObject = data as Record<string, unknown>;
    objects.push(dataObject);
    if (dataObject.data && typeof dataObject.data === "object") {
      const inner = dataObject.data as Record<string, unknown>;
      objects.push(inner);
      if (inner.error && typeof inner.error === "object")
        objects.push(inner.error as Record<string, unknown>);
      if (inner.details && typeof inner.details === "object")
        objects.push(inner.details as Record<string, unknown>);
    }
    if (dataObject.error && typeof dataObject.error === "object") {
      objects.push(dataObject.error as Record<string, unknown>);
    }
    if (dataObject.headers && typeof dataObject.headers === "object") {
      objects.push(dataObject.headers as Record<string, unknown>);
    }
  }
  return objects;
}

/**
 * Extract a safe machine code from the legacy and structured API payloads.
 * Only uppercase snake_case identifiers are accepted.
 */
export function extractErrorCode(payload: unknown): string | null {
  if (typeof payload === "string") return normalizeCode(payload);
  for (const candidate of payloadObjects(payload)) {
    const code = normalizeCode(candidate.code);
    if (code) return code;
  }
  return null;
}

/**
 * Extract a technical reference ID without ever reading server messages.
 * The value is displayed verbatim and is not translated.
 */
export function extractReferenceId(payload: unknown): string | null {
  for (const candidate of payloadObjects(payload)) {
    for (const key of ["referenceId", "requestId", "x-request-id", "X-Request-Id"]) {
      const reference = normalizeReference(candidate[key]);
      if (reference) return reference;
    }
  }
  return null;
}

/**
 * Resolve an API payload into a safe presentation object. Unknown codes keep
 * their stable identifier but use fallback copy, never the raw server text.
 */
export function presentError(payload: unknown): ErrorPresentation {
  const code = extractErrorCode(payload);
  const referenceId = extractReferenceId(payload) ?? undefined;
  if (!code) return { ...FALLBACK, ...(referenceId ? { referenceId } : {}) };

  const entry = ERROR_SCHEMA[code];
  if (!entry) {
    return { ...FALLBACK, code, ...(referenceId ? { referenceId } : {}) };
  }

  return {
    code,
    message: entry.message,
    severity: entry.severity,
    retryable: entry.retryable,
    action: entry.action,
    guidanceKey: entry.guidanceKey,
    ...(entry.retryAfterMs !== undefined ? { retryAfterMs: entry.retryAfterMs } : {}),
    ...(referenceId ? { referenceId } : {}),
  };
}

/**
 * Produce localized user-facing copy. The stable code and reference ID are
 * copied unchanged; only guidance-category copy is translated.
 */
export function localizeError(
  presentation: ErrorPresentation,
  translate: (key: string, values?: Record<string, string | number>) => string,
): LocalizedErrorPresentation {
  const key = presentation.guidanceKey;
  return {
    ...presentation,
    title: translate(`Errors.guidance.${key}.title`),
    message: translate(`Errors.guidance.${key}.message`),
    guidance: translate(`Errors.guidance.${key}.guidance`),
    actionLabel: translate(`Errors.actions.${presentation.action}`),
    referenceLabel: translate("Errors.referenceLabel"),
  };
}

/** Compute a bounded retry delay, or null when the error must not be retried. */
export function nextRetryDelayMs(
  presentation: ErrorPresentation,
  attempt: number,
  maxDelayMs = 30000,
): number | null {
  if (!presentation.retryable) return null;
  const base = presentation.retryAfterMs ?? 1000;
  const safeAttempt = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 1;
  const delay = base * Math.pow(2, safeAttempt - 1);
  return Math.min(delay, maxDelayMs);
}

/** Whether the presentation requires re-authentication before retrying. */
export function requiresReauthentication(presentation: ErrorPresentation): boolean {
  return presentation.action === "reauthenticate";
}
