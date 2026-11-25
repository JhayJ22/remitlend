import type { Request, Response } from 'express';
import { query } from '../db/connection.js';
import { AppError } from '../errors/AppError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getTransferHistoryPage } from '../services/transferHistoryService.js';
import { CacheKeys, invalidateOnProfileUpdate } from '../utils/cacheKeys.js';
import { readThrough } from '../utils/cacheContracts.js';
import type { UpdateUserProfileInput } from '../schemas/userSchemas.js';

/** Profile reads are cached briefly; PATCH /user/profile busts the entry. */
const USER_PROFILE_CACHE_TTL_SECONDS = 120;

interface UserProfileRow {
  id: number;
  public_key: string;
  display_name: string | null;
  email: string | null;
  phone: string | null;
  email_enabled?: boolean | null;
  sms_enabled?: boolean | null;
  created_at: Date | string;
  updated_at: Date | string;
  metadata: Record<string, unknown> | null;
}

function metadataFrom(row: UserProfileRow): Record<string, unknown> {
  return row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function serializeProfile(row: UserProfileRow) {
  const metadata = metadataFrom(row);

  return {
    id: String(row.id),
    email: row.email ?? '',
    walletAddress: row.public_key,
    kycVerified: Boolean(metadata.kycVerified ?? metadata.kyc_verified ?? false),
    displayName: row.display_name ?? '',
    phone: row.phone ?? '',
    locale: typeof metadata.locale === 'string' ? metadata.locale : undefined,
    avatarUrl:
      typeof metadata.avatarUrl === 'string'
        ? metadata.avatarUrl
        : typeof metadata.avatar_url === 'string'
          ? metadata.avatar_url
          : undefined,
    emailEnabled: Boolean(row.email_enabled),
    smsEnabled: Boolean(row.sms_enabled),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

async function getOrCreateProfile(publicKey: string): Promise<UserProfileRow> {
  const result = await query(
    `WITH inserted AS (
       INSERT INTO user_profiles (public_key, metadata)
       VALUES ($1, '{}'::jsonb)
       ON CONFLICT (public_key) DO NOTHING
       RETURNING *
     )
     SELECT * FROM inserted
     UNION ALL
     SELECT * FROM user_profiles WHERE public_key = $1
     LIMIT 1`,
    [publicKey],
  );

  const profile = result.rows[0] as UserProfileRow | undefined;
  if (!profile) {
    throw AppError.internal('Unable to load user profile');
  }

  return profile;
}

export const getUserProfile = asyncHandler(async (req: Request, res: Response) => {
  const publicKey = req.user?.publicKey;
  if (!publicKey) {
    throw AppError.unauthorized('Authentication required');
  }

  const profile = await readThrough(
    'user_profile',
    CacheKeys.userProfile(publicKey),
    USER_PROFILE_CACHE_TTL_SECONDS,
    async () => serializeProfile(await getOrCreateProfile(publicKey)),
  );
  res.json(profile);
});

export const updateUserProfile = asyncHandler(async (req: Request, res: Response) => {
  const publicKey = req.user?.publicKey;
  if (!publicKey) {
    throw AppError.unauthorized('Authentication required');
  }

  const input = req.body as UpdateUserProfileInput;
  const current = await getOrCreateProfile(publicKey);
  const updates: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (input.displayName !== undefined) {
    updates.push(`display_name = $${paramIndex++}`);
    values.push(input.displayName);
  }

  if (input.email !== undefined) {
    updates.push(`email = $${paramIndex++}`);
    values.push(input.email);
  }

  if (input.phone !== undefined) {
    updates.push(`phone = $${paramIndex++}`);
    values.push(input.phone);
  }

  if (input.locale !== undefined || input.avatarUrl !== undefined) {
    const metadata = { ...metadataFrom(current) };

    if (input.locale === null) {
      delete metadata.locale;
    } else if (input.locale !== undefined) {
      metadata.locale = input.locale;
    }

    if (input.avatarUrl === null) {
      delete metadata.avatarUrl;
      delete metadata.avatar_url;
    } else if (input.avatarUrl !== undefined) {
      metadata.avatarUrl = input.avatarUrl;
      delete metadata.avatar_url;
    }

    updates.push(`metadata = $${paramIndex++}::jsonb`);
    values.push(JSON.stringify(metadata));
  }

  if (updates.length === 0) {
    res.json(serializeProfile(current));
    return;
  }

  updates.push('updated_at = CURRENT_TIMESTAMP');
  values.push(publicKey);

  const result = await query(
    `UPDATE user_profiles
     SET ${updates.join(', ')}
     WHERE public_key = $${paramIndex}
     RETURNING *`,
    values,
  );

  const updated = result.rows[0] as UserProfileRow | undefined;
  if (!updated) {
    throw AppError.notFound('User profile not found');
  }

  await invalidateOnProfileUpdate(publicKey);

  res.json(serializeProfile(updated));
});

/**
 * GET /users/:id/transfer-history — paginated NFT transfer events with corridor,
 * amount and timestamp. `:id` is the user's Stellar address; callers may only read
 * their own history unless they are an admin.
 */
export const getTransferHistory = asyncHandler(async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const caller = req.user?.publicKey;
  if (!caller) throw AppError.unauthorized('Authentication required');
  if (caller !== id && req.user?.role !== 'admin') {
    throw AppError.forbidden("Cannot read another user's transfer history");
  }
  const limit = Math.min(
    Math.max(Number.parseInt(String(req.query.limit ?? '20'), 10) || 20, 1),
    100,
  );
  const offset = Math.max(Number.parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);

  const { items, total } = await getTransferHistoryPage(id, limit, offset);
  res.json({ success: true, data: { items }, page: { limit, offset, total } });
});

// ─── Saved recipients (stored in user_profiles.metadata.recipients) ─────────────

interface SavedRecipient {
  id: string;
  name: string;
  address: string;
}

const STELLAR_G_ADDRESS = /^G[A-Z2-7]{55}$/;

function recipientsFrom(row: UserProfileRow): SavedRecipient[] {
  const list = metadataFrom(row).recipients;
  return Array.isArray(list) ? (list as SavedRecipient[]) : [];
}

async function saveRecipients(
  publicKey: string,
  row: UserProfileRow,
  recipients: SavedRecipient[],
) {
  const metadata = { ...metadataFrom(row), recipients };
  await query(
    `UPDATE user_profiles SET metadata = $1::jsonb, updated_at = CURRENT_TIMESTAMP WHERE public_key = $2`,
    [JSON.stringify(metadata), publicKey],
  );
}

export const listRecipients = asyncHandler(async (req: Request, res: Response) => {
  const publicKey = req.user?.publicKey;
  if (!publicKey) throw AppError.unauthorized('Authentication required');
  const profile = await getOrCreateProfile(publicKey);
  res.json({ success: true, data: recipientsFrom(profile) });
});

export const addRecipient = asyncHandler(async (req: Request, res: Response) => {
  const publicKey = req.user?.publicKey;
  if (!publicKey) throw AppError.unauthorized('Authentication required');

  const { name, address } = (req.body ?? {}) as { name?: string; address?: string };
  const trimmedName = typeof name === 'string' ? name.trim() : '';
  const trimmedAddress = typeof address === 'string' ? address.trim() : '';
  if (!trimmedName || trimmedName.length > 100) {
    throw AppError.badRequest('A recipient name (max 100 characters) is required');
  }
  if (!STELLAR_G_ADDRESS.test(trimmedAddress)) {
    throw AppError.badRequest('Recipient address must be a valid Stellar public key');
  }

  const profile = await getOrCreateProfile(publicKey);
  const recipients = recipientsFrom(profile);
  if (recipients.length >= 100) throw AppError.badRequest('Recipient limit reached');
  if (recipients.some((r) => r.address === trimmedAddress)) {
    throw AppError.badRequest('Recipient already saved');
  }

  const recipient: SavedRecipient = {
    id: crypto.randomUUID(),
    name: trimmedName,
    address: trimmedAddress,
  };
  await saveRecipients(publicKey, profile, [...recipients, recipient]);
  res.status(201).json({ success: true, data: recipient });
});

export const deleteRecipient = asyncHandler(async (req: Request, res: Response) => {
  const publicKey = req.user?.publicKey;
  if (!publicKey) throw AppError.unauthorized('Authentication required');

  const profile = await getOrCreateProfile(publicKey);
  const recipients = recipientsFrom(profile);
  const next = recipients.filter((r) => r.id !== req.params.id);
  if (next.length === recipients.length) throw AppError.notFound('Recipient not found');
  await saveRecipients(publicKey, profile, next);
  res.json({ success: true });
});
