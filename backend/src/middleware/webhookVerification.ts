import type { NextFunction, Request, Response } from 'express';
import logger from '../utils/logger.js';
import { AppError } from '../errors/AppError.js';
import {
  verifyWebhookSignature,
  validateWebhookTimestamp,
  getActiveSecret,
} from '../services/webhookSigningService.js';

declare global {
  namespace Express {
    interface Request {
      webhookVerified?: boolean;
      webhookSubscriberId?: string;
    }
  }
}

export async function webhookVerificationMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const signature = req.headers['x-remitlend-signature'];
  const timestamp = req.headers['x-remitlend-timestamp'];
  const subscriberId = req.headers['x-subscriber-id'];

  if (!signature || !timestamp || !subscriberId) {
    return next(
      AppError.unauthorized(
        'Missing webhook signature headers. Include x-remitlend-signature, x-remitlend-timestamp, and x-subscriber-id.',
      ),
    );
  }

  if (
    typeof signature !== 'string' ||
    typeof timestamp !== 'string' ||
    typeof subscriberId !== 'string'
  ) {
    return next(AppError.badRequest('Invalid webhook header format'));
  }

  if (!validateWebhookTimestamp(timestamp)) {
    return next(AppError.unauthorized('Webhook timestamp outside acceptable window'));
  }

  try {
    const secret = await getActiveSecret(subscriberId);

    if (!secret) {
      logger.warn('No active webhook secret found for subscriber', { subscriberId });
      return next(AppError.unauthorized('Webhook secret not found'));
    }

    const bodyStr = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});

    const isValid = verifyWebhookSignature(bodyStr, timestamp, signature, secret);

    if (!isValid) {
      logger.warn('Invalid webhook signature', {
        subscriberId,
        path: req.path,
        timestamp,
      });
      return next(AppError.unauthorized('Invalid webhook signature'));
    }

    req.webhookVerified = true;
    req.webhookSubscriberId = subscriberId;

    next();
  } catch (error) {
    logger.error('Error verifying webhook signature', { error, subscriberId });
    return next(AppError.internal('Failed to verify webhook signature'));
  }
}
