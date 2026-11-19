/**
 * Pure, dependency-free value masking helpers.
 *
 * Extracted from `services/piiCrypto.ts` so that masking can be reused by
 * diagnostic-bundle redaction WITHOUT pulling the AES-GCM / database-pool
 * import graph (issue #846). Masking is a display-only transform: it never
 * touches key material or ciphertext and has no side effects.
 */

export type MaskableField = 'email' | 'phone' | 'name';

/**
 * Mask a sensitive value for safe display/logging.
 *
 * @param value  The plaintext value to mask.
 * @param field  The field discriminator. When omitted (or an unknown kind),
 *               a conservative generic mask is applied so callers that only
 *               know they hold "an opaque identifier" (e.g. a wallet address
 *               surfaced in a diagnostic bundle) still get a safe output.
 *
 * The function is total: any input — including empty, very short, or
 * malformed values — returns a non-empty masked string and never throws.
 */
export function maskValue(value: string, field?: MaskableField): string {
  if (field === 'email') {
    return maskEmail(value);
  }
  if (field === 'phone') {
    return maskPhone(value);
  }
  if (field === 'name') {
    return maskName(value);
  }
  return genericMask(value);
}

function maskEmail(value: string): string {
  const at = value.indexOf('@');
  if (at < 0) {
    return genericMask(value);
  }
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  const maskedLocal = local.length > 0 ? local[0]! + '***' : '***';
  const domainParts = domain.split('.');
  const maskedDomain =
    domainParts.length > 1
      ? (domainParts[0]!.length > 0 ? domainParts[0]![0]! + '***' : '***') +
        '.' +
        domainParts.slice(1).join('.')
      : '***';
  return `${maskedLocal}@${maskedDomain}`;
}

function maskPhone(value: string): string {
  if (value.length <= 4) {
    return '****';
  }
  return '+xx...****' + value.slice(-2);
}

function maskName(value: string): string {
  if (value.length <= 1) {
    return '*';
  }
  return value[0]! + '***' + value.slice(-1);
}

function genericMask(value: string): string {
  // Reveal nothing recognisable; keep a bounded length hint for log scannability.
  if (value.length === 0) {
    return '***';
  }
  if (value.length <= 2) {
    return '*'.repeat(value.length);
  }
  return value[0] + '***' + value.slice(-1);
}
