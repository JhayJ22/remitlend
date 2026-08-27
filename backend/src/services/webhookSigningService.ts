import crypto from 'crypto';
import { query } from '../db/connection.js';
import logger from '../utils/logger.js';

const WEBHOOK_SIGNATURE_HEADER = 'x-remitlend-signature';
const WEBHOOK_TIMESTAMP_HEADER = 'x-remitlend-timestamp';
const REPLAY_WINDOW_SECONDS = 300; // 5 minutes

export interface WebhookSecret {
  id: string;
  subscriberId: string;
  secret: string;
  isActive: boolean;
  createdAt: Date;
  rotatedAt?: Date;
}

export function generateWebhookSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function signWebhookPayload(
  payload: Record<string, unknown>,
  secret: string,
): { signature: string; timestamp: string } {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const payloadStr = JSON.stringify(payload);
  const message = `${payloadStr}.${timestamp}`;

  const signature = crypto.createHmac('sha256', secret).update(message).digest('hex');

  return {
    signature,
    timestamp,
  };
}

export function verifyWebhookSignature(
  payload: string,
  timestamp: string,
  signature: string,
  secret: string,
): boolean {
  const message = `${payload}.${timestamp}`;
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(message)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expectedSignature, 'hex'),
    );
  } catch {
    return false;
  }
}

export async function rotateSubscriberSecret(subscriberId: string): Promise<string> {
  try {
    const newSecret = generateWebhookSecret();
    const newSecretId = crypto.randomUUID();

    await query(
      `INSERT INTO webhook_secrets (id, subscriber_id, secret, is_active, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [newSecretId, subscriberId, newSecret, true, new Date()],
    );

    await query(
      `UPDATE webhook_secrets
       SET is_active = false, rotated_at = $1
       WHERE subscriber_id = $2 AND id != $3 AND is_active = true`,
      [new Date(), subscriberId, newSecretId],
    );

    logger.info('Webhook secret rotated', { subscriberId, newSecretId });

    return newSecret;
  } catch (error) {
    logger.error('Failed to rotate webhook secret', { subscriberId, error });
    throw error;
  }
}

export async function getActiveSecret(subscriberId: string): Promise<string | null> {
  try {
    const result = await query(
      `SELECT secret FROM webhook_secrets
       WHERE subscriber_id = $1 AND is_active = true
       ORDER BY created_at DESC LIMIT 1`,
      [subscriberId],
    );

    return result.rows[0]?.secret || null;
  } catch (error) {
    logger.error('Failed to get active webhook secret', { subscriberId, error });
    return null;
  }
}

export async function getSecretHistory(subscriberId: string, limit = 10): Promise<WebhookSecret[]> {
  try {
    const result = await query(
      `SELECT id, subscriber_id, secret, is_active, created_at, rotated_at
       FROM webhook_secrets
       WHERE subscriber_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [subscriberId, limit],
    );

    return result.rows.map((row) => ({
      id: row.id,
      subscriberId: row.subscriber_id,
      secret: row.secret,
      isActive: row.is_active,
      createdAt: new Date(row.created_at),
      rotatedAt: row.rotated_at ? new Date(row.rotated_at) : undefined,
    }));
  } catch (error) {
    logger.error('Failed to get webhook secret history', { subscriberId, error });
    return [];
  }
}

export function validateWebhookTimestamp(timestamp: string, maxAgeSeconds = REPLAY_WINDOW_SECONDS): boolean {
  try {
    const requestTimestamp = parseInt(timestamp, 10);
    if (isNaN(requestTimestamp)) {
      return false;
    }

    const now = Math.floor(Date.now() / 1000);
    const age = now - requestTimestamp;

    return age >= 0 && age <= maxAgeSeconds;
  } catch {
    return false;
  }
}
