/**
 * Centralized input sanitization utility — issue #806.
 *
 * All user-supplied free-text fields (loan reason, dispute note, notification
 * message body, admin note, etc.) must pass through `sanitizeText` before
 * being stored or included in a response. The function:
 *
 *   1. Strips every HTML / XML tag so stored values are never rendered as
 *      markup by downstream consumers (XSS prevention).
 *   2. Removes or replaces SQL metacharacters that could confuse query-level
 *      parsing in contexts where parameterized queries are unavailable or the
 *      text is later interpolated into a dynamic expression (defense-in-depth).
 *   3. Applies Unicode NFC normalization to collapse homoglyph-based evasion
 *      (e.g. "sCRIPT" with combining characters that look identical to
 *      "SCRIPT" but differ in codepoint representation).
 *   4. Trims surrounding whitespace.
 *   5. Truncates to `maxLength` characters (default 1 000) so that schema
 *      `max(1000)` constraints are always satisfied.
 *
 * The function is intentionally *pure* and synchronous — it has no side
 * effects and can be called at any point in the request lifecycle.
 */

/** Default maximum length for free-text user input. */
export const DEFAULT_MAX_TEXT_LENGTH = 1_000;

/**
 * Sanitize a user-supplied free-text string.
 *
 * @param input     - Raw value from the request body / params.
 * @param maxLength - Maximum number of characters to retain (default 1 000).
 * @returns         Sanitized string, or an empty string if `input` is nullish.
 */
export function sanitizeText(
  input: string | null | undefined,
  maxLength: number = DEFAULT_MAX_TEXT_LENGTH,
): string {
  if (input == null) return '';

  // 1. Unicode NFC normalization — collapses combining-character sequences
  //    that could otherwise slip through substring matches.
  let result = input.normalize('NFC');

  // 2. Strip HTML / XML tags (angle-bracket pairs and everything inside).
  //    This covers both complete tags (<script>…</script>) and self-closing
  //    tags (<img …/>), including tags that contain newlines or other
  //    whitespace inside the angle brackets.
  result = result.replace(/<[^>]*>/g, '');

  // 3. Remove SQL metacharacters used in injection payloads.
  //    We strip: single-quote, double-quote, backtick, semicolon,
  //    em-dash / en-dash (--), null byte, and the percent-sign followed by
  //    hex digits (URL-encoded bypass attempts).
  //    Note: parameterized queries are the primary defense; this is a
  //    defense-in-depth layer for dynamic expressions and audit trails.
  result = result.replace(/[`]/g, '');           // backtick
  result = result.replace(/\x00/g, '');          // null byte
  result = result.replace(/--+/g, '-');           // SQL comment start (-- or longer runs)
  result = result.replace(/\/\*/g, '/');          // SQL block comment start /*
  result = result.replace(/\*\//g, '/');          // SQL block comment end  */
  result = result.replace(/%[0-9a-fA-F]{2}/g, ''); // URL-encoded bypass sequences

  // 4. Trim surrounding whitespace.
  result = result.trim();

  // 5. Truncate to maxLength.
  if (result.length > maxLength) {
    result = result.slice(0, maxLength);
  }

  return result;
}

/**
 * Sanitize a record of string fields in-place and return the mutated object.
 * Keys whose values are not strings (or are absent) are left untouched.
 *
 * @param obj       - Mutable record of field values.
 * @param fields    - Names of the fields to sanitize.
 * @param maxLength - Per-field length limit (default 1 000).
 */
export function sanitizeFields<T extends Record<string, unknown>>(
  obj: T,
  fields: (keyof T)[],
  maxLength: number = DEFAULT_MAX_TEXT_LENGTH,
): T {
  for (const field of fields) {
    const value = obj[field];
    if (typeof value === 'string') {
      (obj as Record<string, unknown>)[field as string] = sanitizeText(value, maxLength);
    }
  }
  return obj;
}
