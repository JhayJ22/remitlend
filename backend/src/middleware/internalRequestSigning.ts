import type { NextFunction, Request, Response } from 'express';
import crypto from 'crypto';
import logger from '../utils/logger.js';
import { AppError } from '../errors/AppError.js';

const SIGNING_SECRET = process.env.INTERNAL_SIGNING_SECRET || 'default-dev-secret';
const SIGNATURE_HEADER = 'x-remitlend-signature';
const TIMESTAMP_HEADER = 'x-remitlend-timestamp';
const MAX_REQUEST_AGE_SECONDS = 300; // 5 minutes

export function signRequest(
  method: string,
  path: string,
  body: string | Record<string, unknown> = '',
  secret: string = SIGNING_SECRET,
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

export function verifyRequestSignature(
  method: string,
  path: string,
  body: string | Record<string, unknown>,
  signature: string,
  timestamp: string,
  secret: string = SIGNING_SECRET,
): boolean {
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
  const message = `${method}|${path}|${bodyStr}|${timestamp}`;

  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(message)
    .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(signature, 'hex'),
    Buffer.from(expectedSignature, 'hex'),
  );
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
