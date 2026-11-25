import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../db/connection.js';
import { AppError } from '../errors/AppError.js';

export const API_KEY_PREFIX = 'rlk_';
export const MAX_API_KEY_TTL_MS = 365 * 24 * 60 * 60 * 1000;

export interface ApiKeyRecord {
  id: number;
  owner: string;
  scopes: string[];
  expiresAt: Date;
  revokedAt: Date | null;
}

export type ApiKeyAuthResult =
  | { status: 'valid'; key: ApiKeyRecord }
  | { status: 'expired' | 'revoked' | 'unknown' };

export const hashApiKey = (raw: string): string =>
  crypto.createHash('sha256').update(raw).digest('hex');

export const isApiKeyToken = (token: string): boolean => token.startsWith(API_KEY_PREFIX);

/** Validates an ISO-8601 expiry: must be in the future and at most one year out. */
export function parseExpiry(expiresAt: string, now = Date.now()): Date {
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) throw AppError.badRequest('expiresAt must be ISO 8601');
  if (date.getTime() <= now) throw AppError.badRequest('expiresAt must be in the future');
  if (date.getTime() > now + MAX_API_KEY_TTL_MS) {
    throw AppError.badRequest('expiresAt must be within 1 year');
  }
  return date;
}

async function insertKey(
  client: Pick<PoolClient, 'query'>,
  owner: string,
  scopes: string[],
  expiresAt: Date,
  rotatedFrom: number | null,
) {
  const raw = `${API_KEY_PREFIX}${crypto.randomBytes(32).toString('hex')}`;
  const res = await client.query(
    `INSERT INTO api_keys (owner, key_hash, key_prefix, scopes, expires_at, rotated_from)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [owner, hashApiKey(raw), raw.slice(0, 8), scopes, expiresAt, rotatedFrom],
  );
  return { id: Number(res.rows[0].id), key: raw, scopes, expiresAt: expiresAt.toISOString() };
}

export async function createApiKey(owner: string, scopes: string[], expiresAt: string) {
  return insertKey({ query }, owner, scopes, parseExpiry(expiresAt), null);
}

/**
 * Atomically revokes the current key and issues a replacement with the same
 * scopes and a fresh expiry (same lifetime as the old key, capped at 1 year).
 */
export async function rotateApiKey(owner: string, id: number) {
  return withTransaction(async (client) => {
    const res = await client.query(
      `UPDATE api_keys SET revoked_at = now()
       WHERE id = $1 AND owner = $2 AND revoked_at IS NULL
       RETURNING scopes, created_at, expires_at`,
      [id, owner],
    );
    const old = res.rows[0];
    if (!old) throw AppError.notFound('API key not found or already revoked');

    const lifetime = Math.min(
      Math.max(new Date(old.expires_at).getTime() - new Date(old.created_at).getTime(), 1),
      MAX_API_KEY_TTL_MS,
    );
    return insertKey(client, owner, old.scopes as string[], new Date(Date.now() + lifetime), id);
  });
}

export async function authenticateApiKey(raw: string): Promise<ApiKeyAuthResult> {
  const res = await query(
    `SELECT id, owner, scopes, expires_at, revoked_at FROM api_keys WHERE key_hash = $1`,
    [hashApiKey(raw)],
  );
  const row = res.rows[0];
  if (!row) return { status: 'unknown' };
  if (row.revoked_at) return { status: 'revoked' };
  const expiresAt = new Date(row.expires_at);
  if (expiresAt.getTime() <= Date.now()) return { status: 'expired' };
  return {
    status: 'valid',
    key: {
      id: Number(row.id),
      owner: String(row.owner),
      scopes: row.scopes as string[],
      expiresAt,
      revokedAt: null,
    },
  };
}
