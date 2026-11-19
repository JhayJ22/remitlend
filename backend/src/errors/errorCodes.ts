/**
 * Centralized error code definitions for API responses.
 *
 * Error codes are machine-readable identifiers that allow the frontend to:
 * - Map errors to i18n translations
 * - Programmatically handle specific error cases
 * - Display user-friendly error messages
 *
 * Format: CATEGORY_ERROR_NAME
 */

export enum ErrorCode {
  // Validation Errors (400)
  INVALID_AMOUNT = 'INVALID_AMOUNT',
  INVALID_PUBLIC_KEY = 'INVALID_PUBLIC_KEY',
  INVALID_SIGNATURE = 'INVALID_SIGNATURE',
  INVALID_CHALLENGE = 'INVALID_CHALLENGE',
  MISSING_FIELD = 'MISSING_FIELD',
  VALIDATION_ERROR = 'VALIDATION_ERROR',

  // Authentication Errors (401)
  UNAUTHORIZED = 'UNAUTHORIZED',
  TOKEN_EXPIRED = 'TOKEN_EXPIRED',
  TOKEN_INVALID = 'TOKEN_INVALID',
  CHALLENGE_EXPIRED = 'CHALLENGE_EXPIRED',
  CHALLENGE_REPLAYED = 'CHALLENGE_REPLAYED',

  // Authorization Errors (403)
  FORBIDDEN = 'FORBIDDEN',
  ACCESS_DENIED = 'ACCESS_DENIED',

  // Not Found Errors (404)
  NOT_FOUND = 'NOT_FOUND',
  LOAN_NOT_FOUND = 'LOAN_NOT_FOUND',
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  POOL_NOT_FOUND = 'POOL_NOT_FOUND',

  // Conflict Errors (409)
  CONFLICT = 'CONFLICT',
  DUPLICATE_REQUEST = 'DUPLICATE_REQUEST',

  // Rate Limiting (429)
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',

  // Server Errors (500)
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  DATABASE_ERROR = 'DATABASE_ERROR',
  EXTERNAL_SERVICE_ERROR = 'EXTERNAL_SERVICE_ERROR',
  BLOCKCHAIN_ERROR = 'BLOCKCHAIN_ERROR',

  // Service Unavailable (503)
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',

  // Specific Business Logic Errors
  BORROWER_MISMATCH = 'BORROWER_MISMATCH',
  INSUFFICIENT_BALANCE = 'INSUFFICIENT_BALANCE',
  LOAN_ALREADY_REPAID = 'LOAN_ALREADY_REPAID',
  LOAN_NOT_ACTIVE = 'LOAN_NOT_ACTIVE',
  INVALID_LOAN_ID = 'INVALID_LOAN_ID',
  INVALID_TX_XDR = 'INVALID_TX_XDR',
}

/**
 * Base URL for error code documentation. Each registry entry links to
 * `${ERROR_DOCS_BASE_URL}#${code}` so clients can deep-link to details.
 */
export const ERROR_DOCS_BASE_URL = 'https://docs.remitwise.app/errors';

/**
 * Error code metadata for documentation and frontend consumption.
 */
export interface ErrorCodeMetadata {
  code: ErrorCode;
  message: string;
  httpStatus: number;
  description: string;
  suggestedAction?: string;
  documentationUrl: string;
}

/**
 * Centralized error code registry with metadata.
 *
 * This is the single source of truth for error codes: HTTP status,
 * user-readable message template, and documentation URL all live here.
 */
export const ERROR_CODE_REGISTRY: Record<ErrorCode, ErrorCodeMetadata> = {
  // Validation Errors
  [ErrorCode.INVALID_AMOUNT]: {
    code: ErrorCode.INVALID_AMOUNT,
    message: 'Amount must be a positive number',
    httpStatus: 400,
    description: 'The provided amount is invalid or not a positive number',
    suggestedAction: 'Provide a valid positive number for the amount field',
    documentationUrl: `${ERROR_DOCS_BASE_URL}#INVALID_AMOUNT`,
  },
  [ErrorCode.INVALID_PUBLIC_KEY]: {
    code: ErrorCode.INVALID_PUBLIC_KEY,
    message: 'Invalid Stellar public key',
    httpStatus: 400,
    description: 'The provided Stellar public key format is invalid',
    suggestedAction: "Provide a valid Stellar public key (starts with 'G')",
    documentationUrl: `${ERROR_DOCS_BASE_URL}#INVALID_PUBLIC_KEY`,
  },
  [ErrorCode.INVALID_SIGNATURE]: {
    code: ErrorCode.INVALID_SIGNATURE,
    message: 'Invalid signature',
    httpStatus: 400,
    description: 'The provided cryptographic signature is invalid',
    suggestedAction: 'Sign the challenge message with your wallet and retry',
    documentationUrl: `${ERROR_DOCS_BASE_URL}#INVALID_SIGNATURE`,
  },
  [ErrorCode.INVALID_CHALLENGE]: {
    code: ErrorCode.INVALID_CHALLENGE,
    message: 'Invalid challenge format',
    httpStatus: 400,
    description: 'The challenge message format is invalid',
    suggestedAction: 'Request a new challenge and retry',
    documentationUrl: `${ERROR_DOCS_BASE_URL}#INVALID_CHALLENGE`,
  },
  [ErrorCode.MISSING_FIELD]: {
    code: ErrorCode.MISSING_FIELD,
    message: 'Required field is missing',
    httpStatus: 400,
    description: 'A required field was not provided in the request',
    suggestedAction: 'Check the request body and include all required fields',
    documentationUrl: `${ERROR_DOCS_BASE_URL}#MISSING_FIELD`,
  },
  [ErrorCode.VALIDATION_ERROR]: {
    code: ErrorCode.VALIDATION_ERROR,
    message: 'Validation failed',
    httpStatus: 400,
    description: 'Request validation failed',
    suggestedAction: 'Review the validation errors and correct the input',
    documentationUrl: `${ERROR_DOCS_BASE_URL}#VALIDATION_ERROR`,
  },

  // Authentication Errors
  [ErrorCode.UNAUTHORIZED]: {
    code: ErrorCode.UNAUTHORIZED,
    message: 'Unauthorized',
    httpStatus: 401,
    description: 'Authentication is required to access this resource',
    suggestedAction: 'Provide valid authentication credentials',
    documentationUrl: `${ERROR_DOCS_BASE_URL}#UNAUTHORIZED`,
  },
  [ErrorCode.TOKEN_EXPIRED]: {
    code: ErrorCode.TOKEN_EXPIRED,
    message: 'Token has expired',
    httpStatus: 401,
    description: 'The JWT token has expired',
    suggestedAction: 'Log in again to obtain a new token',
    documentationUrl: `${ERROR_DOCS_BASE_URL}#TOKEN_EXPIRED`,
  },
  [ErrorCode.TOKEN_INVALID]: {
    code: ErrorCode.TOKEN_INVALID,
    message: 'Invalid token',
    httpStatus: 401,
    description: 'The JWT token is invalid or malformed',
    suggestedAction: 'Log in again to obtain a new token',
    documentationUrl: `${ERROR_DOCS_BASE_URL}#TOKEN_INVALID`,
  },
  [ErrorCode.CHALLENGE_EXPIRED]: {
    code: ErrorCode.CHALLENGE_EXPIRED,
    message: 'Challenge has expired',
    httpStatus: 401,
    description: 'The challenge message has expired (valid for 5 minutes)',
    suggestedAction: 'Request a new challenge and sign it',
    documentationUrl: `${ERROR_DOCS_BASE_URL}#CHALLENGE_EXPIRED`,
  },
  [ErrorCode.CHALLENGE_REPLAYED]: {
    code: ErrorCode.CHALLENGE_REPLAYED,
    message: 'Challenge is invalid or has already been used',
    httpStatus: 401,
    description: 'The challenge was not issued for this wallet or has already been consumed',
    suggestedAction: 'Request a new challenge and sign it',
    documentationUrl: `${ERROR_DOCS_BASE_URL}#CHALLENGE_REPLAYED`,
  },

  // Authorization Errors
  [ErrorCode.FORBIDDEN]: {
    code: ErrorCode.FORBIDDEN,
    message: 'Forbidden',
    httpStatus: 403,
    description: 'You do not have permission to access this resource',
    suggestedAction: 'Ensure you have the required permissions',
    documentationUrl: `${ERROR_DOCS_BASE_URL}#FORBIDDEN`,
  },
  [ErrorCode.ACCESS_DENIED]: {
    code: ErrorCode.ACCESS_DENIED,
    message: 'Access denied',
    httpStatus: 403,
    description: 'Access to this resource is denied',
    suggestedAction: 'Contact support if you believe this is an error',
    documentationUrl: `${ERROR_DOCS_BASE_URL}#ACCESS_DENIED`,
  },
  [ErrorCode.BORROWER_MISMATCH]: {
    code: ErrorCode.BORROWER_MISMATCH,
    message: 'Borrower public key must match your authenticated wallet',
    httpStatus: 403,
    description: 'The borrower public key does not match the authenticated user',
    suggestedAction: 'Ensure the borrower public key matches your wallet',
    documentationUrl: `${ERROR_DOCS_BASE_URL}#BORROWER_MISMATCH`,
  },

  // Not Found Errors
  [ErrorCode.NOT_FOUND]: {
    code: ErrorCode.NOT_FOUND,
    message: 'Resource not found',
    httpStatus: 404,
    description: 'The requested resource does not exist',
    suggestedAction: 'Verify the resource ID and try again',
    documentationUrl: `${ERROR_DOCS_BASE_URL}#NOT_FOUND`,
  },
  [ErrorCode.LOAN_NOT_FOUND]: {
    code: ErrorCode.LOAN_NOT_FOUND,
    message: 'Loan not found',
    httpStatus: 404,
    description: 'The specified loan does not exist',
    suggestedAction: 'Verify the loan ID and try again',
    documentationUrl: `${ERROR_DOCS_BASE_URL}#LOAN_NOT_FOUND`,
  },
  [ErrorCode.USER_NOT_FOUND]: {
    code: ErrorCode.USER_NOT_FOUND,
    message: 'User not found',
    httpStatus: 404,
    description: 'The specified user does not exist',
    suggestedAction: 'Verify the user ID and try again',
    documentationUrl: `${ERROR_DOCS_BASE_URL}#USER_NOT_FOUND`,
  },
  [ErrorCode.POOL_NOT_FOUND]: {
    code: ErrorCode.POOL_NOT_FOUND,
    message: 'Pool not found',
    httpStatus: 404,
    description: 'The specified pool does not exist',
    suggestedAction: 'Verify the pool address and try again',
    documentationUrl: `${ERROR_DOCS_BASE_URL}#POOL_NOT_FOUND`,
  },

  // Conflict Errors
  [ErrorCode.CONFLICT]: {
    code: ErrorCode.CONFLICT,
    message: 'Conflict',
    httpStatus: 409,
    description: 'The request conflicts with the current state of the resource',
    suggestedAction: 'Review the resource state and retry',
    documentationUrl: `${ERROR_DOCS_BASE_URL}#CONFLICT`,
  },
  [ErrorCode.DUPLICATE_REQUEST]: {
    code: ErrorCode.DUPLICATE_REQUEST,
    message: 'Duplicate request',
    httpStatus: 409,
    description: 'This request has already been processed',
    suggestedAction: 'Check if the operation was already completed',
    documentationUrl: `${ERROR_DOCS_BASE_URL}#DUPLICATE_REQUEST`,
  },

  // Rate Limiting
  [ErrorCode.RATE_LIMIT_EXCEEDED]: {
    code: ErrorCode.RATE_LIMIT_EXCEEDED,
    message: 'Rate limit exceeded',
    httpStatus: 429,
    description: 'Too many requests. Please try again later',
    suggestedAction: 'Wait before making another request',
    documentationUrl: `${ERROR_DOCS_BASE_URL}#RATE_LIMIT_EXCEEDED`,
  },

  // Server Errors
  [ErrorCode.INTERNAL_ERROR]: {
    code: ErrorCode.INTERNAL_ERROR,
    message: 'Internal server error',
    httpStatus: 500,
    description: 'An unexpected error occurred on the server',
    suggestedAction: 'Retry the request. If the problem persists, contact support',
    documentationUrl: `${ERROR_DOCS_BASE_URL}#INTERNAL_ERROR`,
  },
  [ErrorCode.DATABASE_ERROR]: {
    code: ErrorCode.DATABASE_ERROR,
    message: 'Database error',
    httpStatus: 500,
    description: 'A database operation failed',
    suggestedAction: 'Retry the request. If the problem persists, contact support',
    documentationUrl: `${ERROR_DOCS_BASE_URL}#DATABASE_ERROR`,
  },
  [ErrorCode.EXTERNAL_SERVICE_ERROR]: {
    code: ErrorCode.EXTERNAL_SERVICE_ERROR,
    message: 'External service error',
    httpStatus: 500,
    description: 'A downstream external service failed',
    suggestedAction: 'Retry the request later',
    documentationUrl: `${ERROR_DOCS_BASE_URL}#EXTERNAL_SERVICE_ERROR`,
  },
  [ErrorCode.BLOCKCHAIN_ERROR]: {
    code: ErrorCode.BLOCKCHAIN_ERROR,
    message: 'Blockchain error',
    httpStatus: 500,
    description: 'A Stellar blockchain operation failed',
    suggestedAction: 'Retry the request later',
    documentationUrl: `${ERROR_DOCS_BASE_URL}#BLOCKCHAIN_ERROR`,
  },

  // Service Unavailable
  [ErrorCode.SERVICE_UNAVAILABLE]: {
    code: ErrorCode.SERVICE_UNAVAILABLE,
    message: 'Service unavailable',
    httpStatus: 503,
    description: 'The service is temporarily unavailable',
    suggestedAction: 'Retry the request later',
    documentationUrl: `${ERROR_DOCS_BASE_URL}#SERVICE_UNAVAILABLE`,
  },

  // Business Logic Errors
  [ErrorCode.INSUFFICIENT_BALANCE]: {
    code: ErrorCode.INSUFFICIENT_BALANCE,
    message: 'Insufficient balance',
    httpStatus: 400,
    description: 'The account does not have enough balance for this operation',
    suggestedAction: 'Fund the account and retry',
    documentationUrl: `${ERROR_DOCS_BASE_URL}#INSUFFICIENT_BALANCE`,
  },
  [ErrorCode.LOAN_ALREADY_REPAID]: {
    code: ErrorCode.LOAN_ALREADY_REPAID,
    message: 'Loan has already been repaid',
    httpStatus: 409,
    description: 'The loan has already been fully repaid',
    suggestedAction: 'No further repayment is required',
    documentationUrl: `${ERROR_DOCS_BASE_URL}#LOAN_ALREADY_REPAID`,
  },
  [ErrorCode.LOAN_NOT_ACTIVE]: {
    code: ErrorCode.LOAN_NOT_ACTIVE,
    message: 'Loan is not active',
    httpStatus: 409,
    description: 'The loan is not in an active state for this operation',
    suggestedAction: 'Verify the loan status and retry',
    documentationUrl: `${ERROR_DOCS_BASE_URL}#LOAN_NOT_ACTIVE`,
  },
  [ErrorCode.INVALID_LOAN_ID]: {
    code: ErrorCode.INVALID_LOAN_ID,
    message: 'Invalid loan ID',
    httpStatus: 400,
    description: 'The provided loan ID is invalid',
    suggestedAction: 'Provide a valid loan ID',
    documentationUrl: `${ERROR_DOCS_BASE_URL}#INVALID_LOAN_ID`,
  },
  [ErrorCode.INVALID_TX_XDR]: {
    code: ErrorCode.INVALID_TX_XDR,
    message: 'Invalid transaction XDR',
    httpStatus: 400,
    description: 'The provided transaction XDR is invalid or malformed',
    suggestedAction: 'Build and sign a valid transaction and retry',
    documentationUrl: `${ERROR_DOCS_BASE_URL}#INVALID_TX_XDR`,
  },
};

/**
 * Look up metadata for an error code. Falls back to INTERNAL_ERROR metadata
 * when the code is unknown so callers always get a usable status/message.
 */
export function getErrorMetadata(code: ErrorCode | string): ErrorCodeMetadata {
  return (
    ERROR_CODE_REGISTRY[code as ErrorCode] ??
    ERROR_CODE_REGISTRY[ErrorCode.INTERNAL_ERROR]
  );
}

/**
 * Full error code inventory, suitable for `GET /docs/errors` and for
 * generating the frontend `lib/errors.ts` mapping.
 */
export function getErrorCodeInventory(): ErrorCodeMetadata[] {
  return Object.values(ERROR_CODE_REGISTRY);
}
