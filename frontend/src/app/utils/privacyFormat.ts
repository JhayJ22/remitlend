/**
 * Privacy-aware formatting utilities for sensitive financial data (#838).
 *
 * These functions wrap the existing inline formatters (formatCurrency,
 * formatBalance, formatScore, formatAddress) and consult the privacy store
 * to decide whether to return the real value or a fixed-width mask.
 *
 * Design invariants:
 *
 * - The mask is a **fixed-width** string ("••••••••") so the rendered output
 *   does not leak the length of the underlying value.
 * - The mask does not contain any portion of the real value.
 * - When `reducedDataMode` is false, the real formatted value is returned
 *   unchanged — the authoritative source of truth (database/chain) is never
 *   modified, only the display layer.
 * - These functions are pure given the `masked` flag; the privacy-aware
 *   wrappers read the store once and pass the flag down.
 */

export const MASK_BALANCE = "••••••••";
export const MASK_ADDRESS = "G••••••••";
export const MASK_SCORE = "•••";

/**
 * Format a currency value, masking it when `masked` is true.
 *
 * @param value   The numeric value to format.
 * @param masked  When true, returns the fixed-width balance mask.
 * @returns       Formatted currency string or the mask.
 */
export function formatCurrency(value: number, masked: boolean): string {
  if (masked) return MASK_BALANCE;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(value);
}

/**
 * Format a percentage value, masking it when `masked` is true.
 *
 * @param value   The fractional value (e.g. 0.08 for 8%).
 * @param masked  When true, returns the fixed-width balance mask.
 * @returns       Formatted percentage string or the mask.
 */
export function formatPercent(value: number, masked: boolean): string {
  if (masked) return MASK_BALANCE;
  return `${(value * 100).toFixed(2)}%`;
}

/**
 * Format a raw balance number, masking it when `masked` is true.
 *
 * @param value   The numeric balance to format.
 * @param masked  When true, returns the fixed-width balance mask.
 * @returns       Formatted balance string or the mask.
 */
export function formatBalance(value: number, masked: boolean): string {
  if (masked) return MASK_BALANCE;
  return value.toLocaleString("en-US", { maximumFractionDigits: 7 });
}

/**
 * Format a wallet address, masking it when `masked` is true.
 *
 * When masked, returns a fixed-width address mask that does not reveal any
 * portion of the real address (unlike `maskAddress` which truncates and shows
 * first 6 + last 4 chars — that leaks partial data).
 *
 * @param address  The wallet address string.
 * @param masked    When true, returns the fixed-width address mask.
 * @returns         The address or the mask. Returns "—" for empty input.
 */
export function formatAddress(address: string | null | undefined, masked: boolean): string {
  if (!address) return "—";
  if (masked) return MASK_ADDRESS;
  return address;
}

/**
 * Truncate a wallet address for compact display, masking it fully when
 * `masked` is true. This replaces the inline `slice(0,6)+"..."+slice(-4)`
 * pattern used across the app.
 *
 * @param address  The wallet address string.
 * @param masked    When true, returns the fixed-width address mask.
 * @returns         Truncated address or the mask.
 */
export function truncateAddress(address: string | null | undefined, masked: boolean): string {
  if (!address) return "—";
  if (masked) return MASK_ADDRESS;
  if (address.length < 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/**
 * Format a credit score number, masking it when `masked` is true.
 *
 * @param score   The numeric credit score.
 * @param masked  When true, returns the fixed-width score mask.
 * @returns       Score as string or the mask.
 */
export function formatScore(score: number | null | undefined, masked: boolean): string {
  if (score === null || score === undefined || score === 0) return "—";
  if (masked) return MASK_SCORE;
  return String(score);
}

/**
 * Format a count (e.g. active loans count), masking it when `masked` is true.
 *
 * @param count   The numeric count.
 * @param masked  When true, returns the fixed-width mask.
 * @returns       Count as string or the mask.
 */
export function formatCount(count: number | null | undefined, masked: boolean): string {
  if (count === null || count === undefined) return "—";
  if (masked) return MASK_SCORE;
  return String(count);
}

/**
 * Resolve a sensitive string value for display, applying the mask when
 * `masked` is true. This is the generalized form of `maskSensitiveValue`
 * from `types/remittance.ts`.
 *
 * @param value   The sensitive string value.
 * @param masked  When true, returns the fixed-width mask.
 * @returns       The value or the mask. Returns "—" for empty input.
 */
export function resolveMaskedValue(value: string | null | undefined, masked: boolean): string {
  if (value === undefined || value === null || value === "") return "—";
  if (masked) return MASK_BALANCE;
  return value;
}
