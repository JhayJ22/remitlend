import type { NextFunction, Request, Response } from 'express';
import crypto from 'crypto';
import logger from '../utils/logger.js';
import { AppError } from '../errors/AppError.js';

const SIGNATURE_HEADER = 'x-remitlend-signature';
const TIMESTAMP_HEADER = 'x-remitlend-timestamp';
const MAX_REQUEST_AGE_SECONDS = 300; // 5 minutes

/**
 * Active signing secrets for internal request verification.
 *
 * `currentSecret` is always the newest secret and is used for signing
 * outbound requests.  `previousSecret` is the old secret retained during the
 * overlap window of a rotation (#851) so that in-flight requests signed with
 * the old secret still verify.  After revocation, `previousSecret` is cleared
 * and only `currentSecret` is accepted.
 *
 * This is an in-process registry: each replica maintains its own copy.  The
 * credential rotation service (#851) coordinates the overlap window and
 * signals when to clear the previous secret.
 */
let currentSecret: string = process.env.INTERNAL_SIGNING_SECRET || 'default-dev-secret';
let previousSecret: string | null = null;

/**
 * Begin the overlap window by setting both the new (current) and old
 * (previous) secrets.  Called by the credential rotation service at the
 * `overlap` stage.  After this call, `verifyRequestSignature` accepts
 * requests signed with either secret, and `signRequest` signs with the
 * new one.
 *
 * @param newSecret  The new signing secret.
 * @param oldSecret  The secret being rotated out (retained for overlap).
 */
export function beginSigningSecretOverlap(newSecret: string, oldSecret: string): void {
  previousSecret = oldSecret;
  currentSecret = newSecret;
  logger.info('internal_signing_secret_overlap_started', {
    current_hash: crypto.createHash('sha256').update(newSecret).digest('hex').slice(0, 8),
    previous_hash: crypto.createHash('sha256').update(oldSecret).digest('hex').slice(0, 8),
  });
}

/**
 * Revoke the old signing secret, ending the overlap window.  After this call,
 * only `currentSecret` is accepted for verification.
 */
export function revokeOldSigningSecret(): void {
  logger.info('internal_signing_secret_overlap_revoked', {
    previous_hash: previousSecret
      ? crypto.createHash('sha256').update(previousSecret).digest('hex').slice(0, 8)
      : null,
  });
  previousSecret = null;
}

/**
 * Get all active secrets that should be accepted for verification.
 * During overlap, returns [current, previous].  Otherwise returns [current].
 */
export function getActiveSigningSecrets(): string[] {
  return previousSecret ? [currentSecret, previousSecret] : [currentSecret];
}

/**
 * Get the current (newest) signing secret.  Used for signing outbound requests.
 */
export function getCurrentSigningSecret(): string {
  return currentSecret;
}

export function signRequest(
  method: string,
  path: string,
  body: string | Record<string, unknown> = '',
  secret: string = currentSecret,
): { signature: string; timestamp: string } {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
  const message = `${method}|${path}|${bodyStr}|${timestamp}`;

  const signature = crypto.createHmac('sha256', secret).update(message).digest('hex');

  return {
    signature,
    timestamp,
  };
}

/**
 * Verify a request signature against all active secrets (current + previous
 * during overlap).  Returns true if the signature matches any active secret.
 */
export function verifyRequestSignature(
  method: string,
  path: string,
  body: string | Record<string, unknown>,
  signature: string,
  timestamp: string,
  secret?: string,
): boolean {
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
  const message = `${method}|${path}|${bodyStr}|${timestamp}`;

  const secretsToCheck = secret ? [secret] : getActiveSigningSecrets();

  for (const s of secretsToCheck) {
    const expectedSignature = crypto
      .createHmac('sha256', s)
      .update(message)
      .digest('hex');

    try {
      if (
        expectedSignature.length === signature.length &&
        crypto.timingSafeEqual(
          Buffer.from(signature, 'hex'),
          Buffer.from(expectedSignature, 'hex'),
        )
      ) {
        return true;
      }
    } catch {
      // signature hex decode failed — try next secret
    }
  }
  return false;
}

export function internalRequestSigningMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const signature = req.headers[SIGNATURE_HEADER];
  const timestamp = req.headers[TIMESTAMP_HEADER];

  if (!signature || !timestamp) {
    return next(
      AppError.unauthorized(
        'Missing internal request signature. Include x-remitlend-signature and x-remitlend-timestamp headers.',
      ),
    );
  }

  if (typeof signature !== 'string' || typeof timestamp !== 'string') {
    return next(
      AppError.badRequest('Invalid signature or timestamp header format'),
    );
  }

  const requestTimestamp = parseInt(timestamp, 10);
  if (isNaN(requestTimestamp)) {
    return next(AppError.badRequest('Invalid timestamp format'));
  }

  const now = Math.floor(Date.now() / 1000);
  const requestAge = now - requestTimestamp;

  if (requestAge < 0 || requestAge > MAX_REQUEST_AGE_SECONDS) {
    return next(
      AppError.unauthorized(
        `Request timestamp outside acceptable window. Age: ${requestAge}s, Max: ${MAX_REQUEST_AGE_SECONDS}s`,
      ),
    );
  }

  const bodyStr = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});

  try {
    const isValid = verifyRequestSignature(
      req.method,
      req.path,
      bodyStr,
      signature,
      timestamp,
    );

    if (!isValid) {
      logger.warn('Invalid internal request signature', {
        path: req.path,
        method: req.method,
        timestamp: requestTimestamp,
      });
      return next(AppError.unauthorized('Invalid internal request signature'));
    }

    next();
  } catch (error) {
    logger.error('Error verifying internal request signature', { error, path: req.path });
    return next(AppError.internal('Failed to verify request signature'));
  }
}

export function getInternalRequestHeaders(
  method: string,
  path: string,
  body?: Record<string, unknown> | string,
): Record<string, string> {
  const { signature, timestamp } = signRequest(method, path, body);
  return {
    [SIGNATURE_HEADER]: signature,
    [TIMESTAMP_HEADER]: timestamp,
  };
}
