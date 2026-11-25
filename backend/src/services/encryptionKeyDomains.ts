/**
 * Encryption key-domain separation by data classification (issue #846).
 *
 * This module is the single source of truth for three things:
 *
 *  1. **Data classification** — a static registry mapping each sensitive
 *     (table, field) pair to one of four data classes. Classification drives
 *     every other decision below.
 *
 *  2. **Key-domain separation** — each data class resolves its own Key
 *     Encryption Key (KEK) identifier and material from class-scoped env vars.
 *     Classes whose env vars are unset fall back to the legacy `PII_KEK_*`
 *     values, so a deployment that only configured the PII KEK keeps working
 *     with a single shared KEK and no data becomes unreadable. Setting the
 *     per-class vars *separates* the domains: a DEK wrapped by one class's
 *     KEK cannot be unwrapped by another class's KEK.
 *
 *  3. **Access roles & revocation** — per-class decryption authority (no
 *     single principal may decrypt every class) and a revocation registry
 *     that fails *closed* for the revoked KEK only, leaving other classes'
 *     ciphertext — and the audit trail — intact and readable.
 *
 * Design notes:
 *  - The audit class is intentionally independent. `pii_access_log` (the
 *    decryption audit trail) is append-only plaintext, so it remains readable
 *    through any other class's rotation or revocation. Encrypting audit
 *    records would require an audit KEK that is never rotated by a
 *    non-audit rotation; we keep the audit KEK in its own domain to preserve
 *    that invariant.
 *  - Revocation is checked synchronously on every encrypt/decrypt path so
 *    the fail-closed property cannot be bypassed by a missed `await`.
 */

import { pool } from '../db/connection.js';
import logger from '../utils/logger.js';

// ─── Data classes ────────────────────────────────────────────────────────────

export type DataClass = 'pii' | 'financial' | 'credential' | 'audit';

export const DATA_CLASSES: readonly DataClass[] = ['pii', 'financial', 'credential', 'audit'] as const;

export const DEFAULT_DATA_CLASS: DataClass = 'pii';

// ─── Field classification registry ──────────────────────────────────────────
//
// Authoritative mapping of sensitive columns to their data class. A field not
// listed here is *not* considered sensitive-enrypted by this subsystem; if an
// unknown field is nevertheless passed through encryptField it is treated as
// `pii` (the most restrictive generally-applicable class) and a warning is
// logged so the registry can be expanded deliberately.

type FieldRegistry = Record<string, Record<string, DataClass>>;

export const FIELD_CLASSIFICATION: FieldRegistry = {
  user_profiles: { email: 'pii', phone: 'pii', display_name: 'pii' },
  remittances: { xdr: 'financial', memo: 'financial' },
  transaction_submissions: { result_xdr: 'financial' },
  webhook_secrets: { secret: 'credential' },
  webhook_subscriptions: { secret: 'credential' },
  // Audit records are their own class so a PII/financial/credential key
  // rotation or revocation can never render audit evidence unreadable.
  audit_logs: { payload: 'audit' },
  pii_access_log: { reason: 'audit', field: 'audit' },
};

/**
 * Resolve the data class for a (table, field) pair.
 *
 * Returns `pii` for unrecognised fields (conservative default) and logs a
 * warning so the registry can be kept deliberate. This never throws.
 */
export function classifyField(tableName: string, fieldName: string): DataClass {
  const tableMap = FIELD_CLASSIFICATION[tableName];
  if (tableMap) {
    const cls = tableMap[fieldName];
    if (cls) {
      return cls;
    }
  }
  logger.warn('encryption_field_unclassified_defaulting_to_pii', {
    table_name: tableName,
    field_name: fieldName,
  });
  return DEFAULT_DATA_CLASS;
}

/** Inverse helper: list every (table, field) pair in a given class. */
export function fieldsForClass(dataClass: DataClass): Array<{ table: string; field: string }> {
  const out: Array<{ table: string; field: string }> = [];
  for (const [table, fields] of Object.entries(FIELD_CLASSIFICATION)) {
    for (const [field, cls] of Object.entries(fields)) {
      if (cls === dataClass) {
        out.push({ table, field });
      }
    }
  }
  return out;
}

// ─── Per-class KEK resolution ─────────────────────────────────────────────────

interface ClassKekEnv {
  readonly kekIdVar: string;
  readonly kekKeyVar: string;
}

const CLASS_KEK_ENV: Record<DataClass, ClassKekEnv> = {
  pii: { kekIdVar: 'PII_KEK_ID', kekKeyVar: 'PII_KEK_KEY' },
  financial: { kekIdVar: 'FINANCIAL_KEK_ID', kekKeyVar: 'FINANCIAL_KEK_KEY' },
  credential: { kekIdVar: 'CREDENTIAL_KEK_ID', kekKeyVar: 'CREDENTIAL_KEK_KEY' },
  audit: { kekIdVar: 'AUDIT_KEK_ID', kekKeyVar: 'AUDIT_KEK_KEY' },
};

/**
 * Legacy default KEK id. Matches the pre-#846 behaviour where
 * `PII_KEK_ID ?? 'default-kek'` was captured once at module load.
 */
const LEGACY_DEFAULT_KEK_ID = 'default-kek';
/** Legacy default KEK material (all-zeros) used when no key is configured. */
const LEGACY_DEFAULT_KEK_KEY = '0'.repeat(64);

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

/**
 * Resolve the logical KEK id for a data class.
 *
 * Resolution order: class-specific env var → legacy `PII_KEK_ID` →
 * `default-kek`. The middle step guarantees that a deployment which only
 * configured `PII_KEK_ID` keeps a single shared KEK id across all classes
 * (i.e. existing ciphertext stays readable) until per-class vars are set.
 */
export function resolveKekId(dataClass: DataClass): string {
  const cfg = CLASS_KEK_ENV[dataClass];
  return env(cfg.kekIdVar) ?? env('PII_KEK_ID') ?? LEGACY_DEFAULT_KEK_ID;
}

/**
 * Resolve the local-mode KEK material (32 raw bytes) for a data class.
 *
 * Resolution order: class-specific env var → legacy `PII_KEK_KEY` → all-zeros.
 * `KMS_ENDPOINT` mode never reads this value (the KMS holds the material), so
 * an all-zeros fallback is only ever used in a misconfigured local deployment.
 */
export function resolveKekKey(dataClass: DataClass): Buffer {
  const cfg = CLASS_KEK_ENV[dataClass];
  const hex = env(cfg.kekKeyVar) ?? env('PII_KEK_KEY') ?? LEGACY_DEFAULT_KEK_KEY;
  return Buffer.from(hex, 'hex');
}

/** KMS endpoint, shared across classes (the KMS scopes keys by kek_id). */
export function resolveKmsEndpoint(): string {
  return env('PII_KMS_ENDPOINT') ?? '';
}

export interface KekContext {
  readonly dataClass: DataClass;
  readonly kekId: string;
  readonly kekKey: Buffer;
  readonly kmsEndpoint: string;
}

/** Resolve the full KEK context (id + material + endpoint) for a class. */
export function resolveKek(dataClass: DataClass): KekContext {
  return {
    dataClass,
    kekId: resolveKekId(dataClass),
    kekKey: resolveKekKey(dataClass),
    kmsEndpoint: resolveKmsEndpoint(),
  };
}

// ─── Per-class access roles ──────────────────────────────────────────────────
//
// Decryption authority is granted per class to a distinct principal, so no
// single principal (other than the operator admin, who needs pii + audit for
// support/compliance) can decrypt every class. Financial, credential, and
// audit access are mutually exclusive to different internal roles.

export type KeyAccessPrincipal =
  | 'admin'
  | 'support'
  | 'transaction-processor'
  | 'credential-rotator'
  | 'auditor'
  | 'system'
  | 'borrower'
  | 'lender'
  | 'anonymous';

export const CLASS_DECRYPT_SCOPE: Record<DataClass, string> = {
  pii: 'decrypt:pii',
  financial: 'decrypt:financial',
  credential: 'decrypt:credential',
  audit: 'decrypt:audit',
};

const DECRYPT_GRANTS: Record<KeyAccessPrincipal, DataClass[]> = {
  admin: ['pii', 'audit'],
  support: ['pii'],
  'transaction-processor': ['financial'],
  'credential-rotator': ['credential'],
  auditor: ['audit'],
  system: [],
  borrower: [],
  lender: [],
  anonymous: [],
};

/** Whether `principal` is authorised to decrypt fields of `dataClass`. */
export function canDecryptClass(principal: KeyAccessPrincipal, dataClass: DataClass): boolean {
  return DECRYPT_GRANTS[principal].includes(dataClass);
}

/** Assert access; throws `KeyAccessDeniedError` when not authorised. */
export function assertCanDecrypt(principal: KeyAccessPrincipal, dataClass: DataClass): void {
  if (!canDecryptClass(principal, dataClass)) {
    throw new KeyAccessDeniedError(principal, dataClass);
  }
}

// ─── Errors ──────────────────────────────────────────────────────────────────

export class KeyRevokedError extends Error {
  public readonly kekId: string;
  constructor(kekId: string) {
    super(`KEK ${kekId} has been revoked; decryption refused (fail-closed)`);
    this.name = 'KeyRevokedError';
    this.kekId = kekId;
  }
}

export class KeyAccessDeniedError extends Error {
  public readonly principal: KeyAccessPrincipal;
  public readonly dataClass: DataClass;
  constructor(principal: KeyAccessPrincipal, dataClass: DataClass) {
    super(`Principal '${principal}' is not authorised to decrypt class '${dataClass}'`);
    this.name = 'KeyAccessDeniedError';
    this.principal = principal;
    this.dataClass = dataClass;
  }
}

// ─── Revocation registry ─────────────────────────────────────────────────────
//
// Revocation is the mechanism that proves "rotation/revocation in one class
// does not decrypt unrelated data": revoking a KEK only blocks the class(es)
// wrapped under that KEK id. Because classes use distinct KEK ids (when
// configured), revoking the PII KEK leaves financial/credential/audit
// ciphertext fully decryptable. The registry is in-memory (checked
// synchronously on the hot path) and seeded from `kek_revocations` on
// startup; `revokeKek` updates both atomically (best-effort DB write).

const revokedKekIds = new Set<string>();

/** Synchronous hot-path check used by encrypt/decrypt. Never throws. */
export function isKekRevoked(kekId: string): boolean {
  return revokedKekIds.has(kekId);
}

export interface RevokeKekOptions {
  readonly dataClass: DataClass;
  readonly actor: string;
  readonly reason: string;
  readonly requestId: string;
}

/**
 * Revoke a KEK id. The in-memory revocation takes effect immediately (even
 * if the DB write fails), so the fail-closed property holds within this
 * process. Durability across restarts is provided by the `kek_revocations`
 * table, loaded by `loadRevocations()` on startup.
 */
export async function revokeKek(kekId: string, opts: RevokeKekOptions): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO kek_revocations (id, kek_id, data_class, revoked_by, reason, request_id, revoked_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, NOW())
       ON CONFLICT (kek_id) DO NOTHING`,
      [kekId, opts.dataClass, opts.actor, opts.reason, opts.requestId],
    );
  } catch (err) {
    // DB may be unavailable (unit tests, degraded mode). The in-memory
    // revocation below still takes effect for this process.
    logger.warn('kek_revocation_persist_failed', {
      kek_id: kekId,
      data_class: opts.dataClass,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  revokedKekIds.add(kekId);
  logger.warn('kek_revoked', {
    kek_id: kekId,
    data_class: opts.dataClass,
    actor: opts.actor,
    reason: opts.reason,
  });
}

/** Load durable revocations from the DB into the in-memory set (startup). */
export async function loadRevocations(): Promise<void> {
  try {
    const result = await pool.query('SELECT kek_id FROM kek_revocations');
    for (const row of result.rows as Array<{ kek_id: string }>) {
      revokedKekIds.add(row.kek_id);
    }
    if (revokedKekIds.size > 0) {
      logger.info('kek_revocations_loaded', { count: revokedKekIds.size });
    }
  } catch (err) {
    logger.warn('kek_revocations_load_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Test-only: clear the in-memory revocation set. */
export function __resetRevocationsForTest(): void {
  revokedKekIds.clear();
}
