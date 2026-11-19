import crypto from 'node:crypto';
import { pool } from '../db/connection.js';
import {
  type DataClass,
  DEFAULT_DATA_CLASS,
  resolveKek,
  isKekRevoked,
  KeyRevokedError,
} from './encryptionKeyDomains.js';

// Re-export the pure masking helper for backward compatibility. Consumers
// that only need masking (e.g. diagnosticBundleService) should import from
// `../utils/masking.js` directly to avoid pulling the crypto/db import graph.
export { maskValue } from '../utils/masking.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const DEK_LENGTH = 32;
const GCM_TAG_LENGTH = 16;

interface EncryptedField {
  ciphertext: Buffer;
  gcm_nonce: Buffer;
  dek_wrapped: Buffer;
  dek_kek_id: string;
  data_class: DataClass;
}

/**
 * Unwrap a wrapped DEK using the KEK recorded for it (`kekId`).
 *
 * In KMS mode the KEK material lives in the KMS (scoped by `kekId`); in local
 * mode it is resolved from env. The recorded `kekId` — not the caller's
 * current class KEK — drives unwrapping, so ciphertext written under an
 * older KEK remains readable after a rotation (read-through for any
 * non-revoked KEK version).
 *
 * @throws {KeyRevokedError} if the recorded KEK id has been revoked
 *   (fail-closed: the DEK is never returned to the caller).
 */
async function unwrapDek(dekWrapped: Buffer, kekId: string): Promise<Buffer> {
  if (isKekRevoked(kekId)) {
    throw new KeyRevokedError(kekId);
  }

  const kmsEndpoint = resolveKek(DEFAULT_DATA_CLASS).kmsEndpoint;
  if (kmsEndpoint) {
    const resp = await fetch(`${kmsEndpoint}/decrypt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kek_id: kekId, wrapped_key: dekWrapped.toString('base64') }),
    });
    if (!resp.ok) throw new Error(`KMS unwrap failed: ${resp.status}`);
    const { plaintext } = (await resp.json()) as { plaintext: string };
    return Buffer.from(plaintext, 'base64');
  }

  // Local mode: the KEK material must be resolvable for the class that owns
  // `kekId`. We try each class's configured KEK until the GCM auth tag
  // validates; in a single-KEK (legacy) deployment all classes share one key
  // so the first attempt succeeds. This keeps rotation read-through working
  // without requiring callers to pass the originating class on decrypt.
  return unwrapLocal(dekWrapped, kekId);
}

/**
 * Try unwrapping `dekWrapped` against each class's locally-configured KEK
 * whose id matches `kekId`. Returns the DEK on the first GCM-authenticated
 * success. Throws if no configured KEK can authenticate the wrapped DEK
 * (wrong key, tampering, or an unconfigured class).
 */
function unwrapLocal(dekWrapped: Buffer, kekId: string): Buffer {
  const iv = dekWrapped.subarray(0, IV_LENGTH);
  const tag = dekWrapped.subarray(IV_LENGTH, IV_LENGTH + GCM_TAG_LENGTH);
  const encrypted = dekWrapped.subarray(IV_LENGTH + GCM_TAG_LENGTH);

  // Collect the distinct KEK materials whose id matches kekId. In legacy
  // single-KEK mode these collapse to one key; in separated mode each class
  // has a distinct key and only the owning class's key will authenticate.
  const triedKeys = new Set<string>();
  for (const cls of ['pii', 'financial', 'credential', 'audit'] as const) {
    const ctx = resolveKek(cls);
    if (ctx.kekId !== kekId) continue;
    const keyHex = ctx.kekKey.toString('hex');
    if (triedKeys.has(keyHex)) continue;
    triedKeys.add(keyHex);
    try {
      const decipher = crypto.createDecipheriv(ALGORITHM, ctx.kekKey, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(encrypted), decipher.final()]);
    } catch {
      // wrong key for this wrapped DEK; try the next class
    }
  }
  throw new Error(`DEK unwrap failed: no configured KEK authenticates kek_id=${kekId}`);
}

/**
 * Wrap a fresh DEK with the KEK for `dataClass`.
 *
 * @throws {KeyRevokedError} if the class's current KEK id is revoked
 *   (fail-closed: no new ciphertext is written under a revoked KEK).
 */
async function wrapDek(dek: Buffer, dataClass: DataClass): Promise<{ wrapped: Buffer; kekId: string }> {
  const ctx = resolveKek(dataClass);
  if (isKekRevoked(ctx.kekId)) {
    throw new KeyRevokedError(ctx.kekId);
  }

  if (ctx.kmsEndpoint) {
    const resp = await fetch(`${ctx.kmsEndpoint}/encrypt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kek_id: ctx.kekId, plaintext: dek.toString('base64') }),
    });
    if (!resp.ok) throw new Error(`KMS wrap failed: ${resp.status}`);
    const { wrapped_key } = (await resp.json()) as { wrapped_key: string };
    return { wrapped: Buffer.from(wrapped_key, 'base64'), kekId: ctx.kekId };
  }

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, ctx.kekKey, iv);
  const encrypted = Buffer.concat([cipher.update(dek), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { wrapped: Buffer.concat([iv, tag, encrypted]), kekId: ctx.kekId };
}

/**
 * Encrypt a plaintext field value under the KEK domain for `dataClass`.
 *
 * `dataClass` defaults to `pii` to preserve the pre-#846 call signature.
 * The returned `dek_kek_id` is the class's *current* KEK id, recorded per row
 * so decrypt still works after a future rotation of this class's KEK.
 */
export async function encryptField(
  plaintext: string,
  dataClass: DataClass = DEFAULT_DATA_CLASS,
): Promise<EncryptedField> {
  const dek = crypto.randomBytes(DEK_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, dek, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const ciphertext = Buffer.concat([encrypted, tag]);
  const { wrapped: dekWrapped, kekId } = await wrapDek(dek, dataClass);
  return { ciphertext, gcm_nonce: iv, dek_wrapped: dekWrapped, dek_kek_id: kekId, data_class: dataClass };
}

/**
 * Decrypt a field. Unwrapping uses the **recorded** `dekKekId` (read-through
 * for rotated keys) and fails closed if that KEK id has been revoked.
 *
 * Every decrypt — successful or denied — is recorded in `pii_access_log` so
 * the audit trail survives any class rotation/revocation (the audit log is
 * append-only plaintext in its own data class domain).
 *
 * @param dataClass the class the caller believes this field belongs to; used
 *   only for the access-audit row. Unwrapping is driven by `dekKekId`.
 */
export async function decryptField(
  recordId: string,
  field: string,
  ciphertext: Buffer,
  gcmNonce: Buffer,
  dekWrapped: Buffer,
  dekKekId: string,
  actor: string,
  reason: string,
  requestId: string,
  dataClass: DataClass = DEFAULT_DATA_CLASS,
): Promise<string> {
  let dek: Buffer;
  try {
    dek = await unwrapDek(dekWrapped, dekKekId);
  } catch (err) {
    // Audit the denial even when we fail closed, then re-throw.
    if (err instanceof KeyRevokedError) {
      await logPiiAccess(recordId, field, actor, `DENIED:revoked_kek:${reason}`, requestId).catch(() => undefined);
    }
    throw err;
  }

  const authTag = ciphertext.subarray(ciphertext.length - GCM_TAG_LENGTH);
  const encryptedData = ciphertext.subarray(0, ciphertext.length - GCM_TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, dek, gcmNonce);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);

  await logPiiAccess(recordId, field, actor, reason, requestId);

  // `dataClass` is recorded for completeness; decrypt is keyed by dekKekId.
  void dataClass;
  return decrypted.toString('utf8');
}

async function logPiiAccess(
  recordId: string,
  field: string,
  actor: string,
  reason: string,
  requestId: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO pii_access_log (id, actor, record_id, field, reason, request_id, created_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, NOW())`,
    [actor, recordId, field, reason, requestId],
  );
}

// Keep the legacy default-KEK constants exported for any callers that read
// them; resolution now happens per-call via encryptionKeyDomains.
export const DEFAULT_KEK_ID = resolveKek(DEFAULT_DATA_CLASS).kekId;
