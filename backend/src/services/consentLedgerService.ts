/**
 * Consent ledger service (#845).
 *
 * Records purpose-specific processing grants and revocations for each user.
 * Every write is append-only (enforced at the DB level by a trigger).
 * Downstream jobs call isConsentGranted() before processing any user's data.
 *
 * Supported purposes:
 *   credit_score_processing  — credit-score algorithm over repayment history
 *   remittance_analytics     — aggregate remittance amounts for pool analytics
 *   marketing_communications — promotional / product-update emails & SMS
 *   third_party_sharing      — anonymised data sharing with regulated parties
 *
 * No financial data is touched here. All amounts and scores stay in their
 * own services; this service only manages the boolean processing permission.
 */

import { randomUUID } from 'node:crypto';
import { query } from '../db/connection.js';
import { AppError } from '../errors/AppError.js';
import logger from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CONSENT_PURPOSES = [
  'credit_score_processing',
  'remittance_analytics',
  'marketing_communications',
  'third_party_sharing',
] as const;

export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];

export const CONSENT_DATA_CATEGORIES = [
  'wallet_address',
  'credit_score',
  'remittance_history',
  'loan_history',
  'contact_info',
] as const;

export type ConsentDataCategory = (typeof CONSENT_DATA_CATEGORIES)[number];

/** Minimum policy version the service will accept on new grants. */
export const CURRENT_POLICY_VERSION = '1.0';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConsentStatus = 'granted' | 'revoked' | 'expired';

export interface ConsentRecord {
  id: string;
  userId: string;
  purpose: ConsentPurpose;
  status: ConsentStatus;
  policyVersion: string;
  dataCategories: ConsentDataCategory[];
  revocationReason: string | null;
  idempotencyKey: string;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
}

export interface EffectiveConsent {
  id: string;
  userId: string;
  purpose: ConsentPurpose;
  status: ConsentStatus;
  policyVersion: string;
  dataCategories: ConsentDataCategory[];
  effectiveSince: Date;
}

export interface GrantConsentInput {
  userId: string;
  purpose: ConsentPurpose;
  policyVersion: string;
  dataCategories: ConsentDataCategory[];
  idempotencyKey: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface RevokeConsentInput {
  userId: string;
  purpose: ConsentPurpose;
  revocationReason?: string | null;
  idempotencyKey: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function assertValidPurpose(purpose: string): asserts purpose is ConsentPurpose {
  if (!CONSENT_PURPOSES.includes(purpose as ConsentPurpose)) {
    throw AppError.badRequest(
      `Unsupported consent purpose: ${purpose}. Allowed: ${CONSENT_PURPOSES.join(', ')}`,
    );
  }
}

function assertValidCategories(categories: string[]): asserts categories is ConsentDataCategory[] {
  for (const cat of categories) {
    if (!CONSENT_DATA_CATEGORIES.includes(cat as ConsentDataCategory)) {
      throw AppError.badRequest(
        `Unknown data category: ${cat}. Allowed: ${CONSENT_DATA_CATEGORIES.join(', ')}`,
      );
    }
  }
}

function assertValidPolicyVersion(version: string): void {
  if (!/^\d+\.\d+$/.test(version)) {
    throw AppError.badRequest(
      'policy_version must be in MAJOR.MINOR format (e.g. "1.0")',
    );
  }
}

// ---------------------------------------------------------------------------
// Row mapper
// ---------------------------------------------------------------------------

function rowToRecord(row: Record<string, unknown>): ConsentRecord {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    purpose: row.purpose as ConsentPurpose,
    status: row.status as ConsentStatus,
    policyVersion: row.policy_version as string,
    dataCategories: (row.data_categories as ConsentDataCategory[]) ?? [],
    revocationReason: (row.revocation_reason as string | null) ?? null,
    idempotencyKey: row.idempotency_key as string,
    ipAddress: (row.ip_address as string | null) ?? null,
    userAgent: (row.user_agent as string | null) ?? null,
    createdAt: new Date(row.created_at as string),
  };
}

function rowToEffective(row: Record<string, unknown>): EffectiveConsent {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    purpose: row.purpose as ConsentPurpose,
    status: row.status as ConsentStatus,
    policyVersion: row.policy_version as string,
    dataCategories: (row.data_categories as ConsentDataCategory[]) ?? [],
    effectiveSince: new Date(row.effective_since as string),
  };
}

// ---------------------------------------------------------------------------
// Audit helper
// ---------------------------------------------------------------------------

async function audit(
  userId: string,
  action: string,
  consentId: string,
  detail: Record<string, unknown>,
): Promise<void> {
  try {
    await query(
      `INSERT INTO audit_logs (actor, action, target, payload, status)
       VALUES ($1, $2, $3, $4::jsonb, 200)`,
      [userId, action, `Consent:${consentId}`, JSON.stringify(detail)],
    );
  } catch (error) {
    logger.error('Failed to write consent audit entry', { error, action, consentId });
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Records a new consent grant.  Idempotent: a duplicate idempotency_key
 * returns the existing row (via conflict detection) rather than failing.
 *
 * Returns the new (or existing) consent record.
 */
export async function grantConsent(input: GrantConsentInput): Promise<ConsentRecord> {
  assertValidPurpose(input.purpose);
  assertValidCategories(input.dataCategories);
  assertValidPolicyVersion(input.policyVersion);

  if (!input.idempotencyKey || input.idempotencyKey.trim().length === 0) {
    throw AppError.badRequest('idempotency_key is required');
  }

  const id = randomUUID();

  try {
    const result = await query(
      `INSERT INTO consent_ledger
         (id, user_id, purpose, status, policy_version, data_categories,
          idempotency_key, ip_address, user_agent)
       VALUES ($1, $2, $3, 'granted', $4, $5::jsonb, $6, $7, $8)
       RETURNING *`,
      [
        id,
        input.userId,
        input.purpose,
        input.policyVersion,
        JSON.stringify(input.dataCategories),
        input.idempotencyKey,
        input.ipAddress ?? null,
        input.userAgent ?? null,
      ],
    );

    const record = rowToRecord(result.rows[0] as Record<string, unknown>);

    await audit(input.userId, 'CONSENT_GRANTED', record.id, {
      purpose: input.purpose,
      policyVersion: input.policyVersion,
      dataCategories: input.dataCategories,
    });

    logger.info('Consent granted', {
      userId: input.userId,
      purpose: input.purpose,
      policyVersion: input.policyVersion,
      consentId: record.id,
    });

    return record;
  } catch (err: unknown) {
    const pgError = err as { code?: string };
    if (pgError.code === '23505') {
      // Duplicate idempotency_key — return the existing record.
      const existing = await query(
        `SELECT * FROM consent_ledger WHERE idempotency_key = $1`,
        [input.idempotencyKey],
      );
      if (existing.rows[0]) return rowToRecord(existing.rows[0] as Record<string, unknown>);
      // Idempotency key was on a different unique column — surface as conflict.
      throw AppError.conflict('A consent record with this idempotency key already exists');
    }
    throw err;
  }
}

/**
 * Records a consent revocation.  Requires that an active 'granted' record
 * exists for the given (userId, purpose) pair.  Does not fail silently:
 * revoking a non-existent or already-revoked consent throws 409.
 *
 * Returns the new revocation record.
 */
export async function revokeConsent(input: RevokeConsentInput): Promise<ConsentRecord> {
  assertValidPurpose(input.purpose);

  if (!input.idempotencyKey || input.idempotencyKey.trim().length === 0) {
    throw AppError.badRequest('idempotency_key is required');
  }

  // Check current effective consent before inserting.
  const current = await query(
    `SELECT status, policy_version, data_categories
     FROM consent_effective
     WHERE user_id = $1 AND purpose = $2`,
    [input.userId, input.purpose],
  );

  const currentRow = current.rows[0] as
    | { status: string; policy_version: string; data_categories: ConsentDataCategory[] }
    | undefined;

  if (!currentRow) {
    throw AppError.notFound(
      `No consent record found for purpose '${input.purpose}'. Grant consent before revoking.`,
    );
  }

  if (currentRow.status !== 'granted') {
    throw AppError.conflict(
      `Cannot revoke consent: current status is '${currentRow.status}'.`,
    );
  }

  const id = randomUUID();

  try {
    const result = await query(
      `INSERT INTO consent_ledger
         (id, user_id, purpose, status, policy_version, data_categories,
          revocation_reason, idempotency_key, ip_address, user_agent)
       VALUES ($1, $2, $3, 'revoked', $4, $5::jsonb, $6, $7, $8, $9)
       RETURNING *`,
      [
        id,
        input.userId,
        input.purpose,
        currentRow.policy_version,
        JSON.stringify(currentRow.data_categories),
        input.revocationReason ?? null,
        input.idempotencyKey,
        input.ipAddress ?? null,
        input.userAgent ?? null,
      ],
    );

    const record = rowToRecord(result.rows[0] as Record<string, unknown>);

    await audit(input.userId, 'CONSENT_REVOKED', record.id, {
      purpose: input.purpose,
      revocationReason: input.revocationReason ?? null,
    });

    logger.info('Consent revoked', {
      userId: input.userId,
      purpose: input.purpose,
      consentId: record.id,
    });

    return record;
  } catch (err: unknown) {
    const pgError = err as { code?: string };
    if (pgError.code === '23505') {
      const existing = await query(
        `SELECT * FROM consent_ledger WHERE idempotency_key = $1`,
        [input.idempotencyKey],
      );
      if (existing.rows[0]) return rowToRecord(existing.rows[0] as Record<string, unknown>);
      throw AppError.conflict('A consent record with this idempotency key already exists');
    }
    throw err;
  }
}

/**
 * Returns the full append-only consent history for the given user,
 * newest first.  Optionally filtered by purpose.
 */
export async function listConsentHistory(
  userId: string,
  options: { purpose?: ConsentPurpose; limit?: number; cursor?: string } = {},
): Promise<ConsentRecord[]> {
  const conditions: string[] = ['user_id = $1'];
  const values: unknown[] = [userId];

  if (options.purpose) {
    assertValidPurpose(options.purpose);
    values.push(options.purpose);
    conditions.push(`purpose = $${values.length}`);
  }

  if (options.cursor) {
    // cursor is an ISO timestamp; return rows older than it (keyset pagination)
    values.push(options.cursor);
    conditions.push(`created_at < $${values.length}`);
  }

  values.push(Math.min(options.limit ?? 50, 200));

  const result = await query(
    `SELECT * FROM consent_ledger
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC
     LIMIT $${values.length}`,
    values,
  );

  return (result.rows as Array<Record<string, unknown>>).map(rowToRecord);
}

/**
 * Returns the current effective consent for every purpose for a user.
 * Missing purposes are absent from the result (not null entries).
 */
export async function getEffectiveConsents(userId: string): Promise<EffectiveConsent[]> {
  const result = await query(
    `SELECT * FROM consent_effective WHERE user_id = $1 ORDER BY purpose`,
    [userId],
  );
  return (result.rows as Array<Record<string, unknown>>).map(rowToEffective);
}

/**
 * Returns true when the user has an active 'granted' consent for the given
 * purpose and the policy version matches or is newer than the minimum required.
 *
 * Downstream jobs MUST call this before processing any user data for the
 * corresponding purpose.  If this returns false, the job MUST skip the user.
 */
export async function isConsentGranted(
  userId: string,
  purpose: ConsentPurpose,
  minimumPolicyVersion: string = CURRENT_POLICY_VERSION,
): Promise<boolean> {
  assertValidPurpose(purpose);

  const result = await query(
    `SELECT status, policy_version
     FROM consent_effective
     WHERE user_id = $1 AND purpose = $2`,
    [userId, purpose],
  );

  const row = result.rows[0] as { status: string; policy_version: string } | undefined;
  if (!row || row.status !== 'granted') return false;

  // Compare major.minor versions as numeric tuples — no semver library needed.
  const [reqMaj, reqMin] = minimumPolicyVersion.split('.').map(Number);
  const [rowMaj, rowMin] = row.policy_version.split('.').map(Number);
  if (reqMaj === undefined || reqMin === undefined || rowMaj === undefined || rowMin === undefined) {
    return false;
  }
  if (rowMaj > reqMaj) return true;
  if (rowMaj < reqMaj) return false;
  return rowMin >= reqMin;
}
