/**
 * Privacy-aware formatting tests (#838).
 *
 * Verifies that:
 * - Masking returns a fixed-width string that does not leak the real value
 * - When masked=false, the real formatted value is returned unchanged
 * - Empty/null/undefined inputs return "—"
 * - Each formatter (currency, percent, balance, address, score, count) masks correctly
 * - The mask constant is fixed-width (does not vary by input length)
 */

import { describe, it, expect } from "@jest/globals";
import {
  formatCurrency,
  formatPercent,
  formatBalance,
  formatAddress,
  truncateAddress,
  formatScore,
  formatCount,
  resolveMaskedValue,
  MASK_BALANCE,
  MASK_ADDRESS,
  MASK_SCORE,
} from "../privacyFormat";

// ── Mask constants ────────────────────────────────────────────────────────────

describe("mask constants", () => {
  it("MASK_BALANCE is a fixed-width string", () => {
    expect(MASK_BALANCE).toBe("••••••••");
    expect(MASK_BALANCE.length).toBe(8);
  });

  it("MASK_ADDRESS is a fixed-width string prefixed with G", () => {
    expect(MASK_ADDRESS).toBe("G••••••••");
    expect(MASK_ADDRESS.length).toBe(9);
  });

  it("MASK_SCORE is a fixed-width string", () => {
    expect(MASK_SCORE).toBe("•••");
    expect(MASK_SCORE.length).toBe(3);
  });
});

// ── formatCurrency ────────────────────────────────────────────────────────────

describe("formatCurrency", () => {
  it("returns formatted currency when not masked", () => {
    expect(formatCurrency(1234.56, false)).toBe("$1,234.56");
  });

  it("returns the mask when masked", () => {
    expect(formatCurrency(1234.56, true)).toBe(MASK_BALANCE);
  });

  it("returns the mask for zero when masked", () => {
    expect(formatCurrency(0, true)).toBe(MASK_BALANCE);
  });

  it("does not leak the value in the mask", () => {
    const masked = formatCurrency(99999.99, true);
    expect(masked).not.toContain("99999");
    expect(masked).not.toContain("99");
  });
});

// ── formatPercent ─────────────────────────────────────────────────────────────

describe("formatPercent", () => {
  it("returns formatted percentage when not masked", () => {
    expect(formatPercent(0.08, false)).toBe("8.00%");
  });

  it("returns the mask when masked", () => {
    expect(formatPercent(0.08, true)).toBe(MASK_BALANCE);
  });

  it("does not leak the value in the mask", () => {
    const masked = formatPercent(0.1234, true);
    expect(masked).not.toContain("12");
    expect(masked).not.toContain("34");
  });
});

// ── formatBalance ─────────────────────────────────────────────────────────────

describe("formatBalance", () => {
  it("returns formatted balance when not masked", () => {
    expect(formatBalance(1234.5678, false)).toBe("1,234.5678");
  });

  it("returns the mask when masked", () => {
    expect(formatBalance(1234.5678, true)).toBe(MASK_BALANCE);
  });

  it("does not leak the value in the mask", () => {
    const masked = formatBalance(12345.6789, true);
    expect(masked).not.toContain("12345");
    expect(masked).not.toContain("6789");
  });
});

// ── formatAddress ─────────────────────────────────────────────────────────────

describe("formatAddress", () => {
  const ADDRESS = "GBORROWER123TESTADDRESS456STELLARWALLET789ABCDEFGHIJ";

  it("returns the address when not masked", () => {
    expect(formatAddress(ADDRESS, false)).toBe(ADDRESS);
  });

  it("returns the mask when masked", () => {
    expect(formatAddress(ADDRESS, true)).toBe(MASK_ADDRESS);
  });

  it("does not leak any portion of the address when masked", () => {
    const masked = formatAddress(ADDRESS, true);
    expect(masked).not.toContain("GBORROWER");
    expect(masked).not.toContain("123TEST");
    expect(masked).not.toContain(ADDRESS.slice(0, 6));
    expect(masked).not.toContain(ADDRESS.slice(-4));
  });

  it("returns — for null input", () => {
    expect(formatAddress(null, false)).toBe("—");
    expect(formatAddress(null, true)).toBe("—");
  });

  it("returns — for undefined input", () => {
    expect(formatAddress(undefined, false)).toBe("—");
    expect(formatAddress(undefined, true)).toBe("—");
  });

  it("returns — for empty string input", () => {
    expect(formatAddress("", false)).toBe("—");
    expect(formatAddress("", true)).toBe("—");
  });
});

// ── truncateAddress ──────────────────────────────────────────────────────────

describe("truncateAddress", () => {
  const ADDRESS = "GBORROWER123TESTADDRESS456STELLARWALLET789ABCDEFGHIJ";

  it("returns truncated address when not masked", () => {
    const truncated = truncateAddress(ADDRESS, false);
    expect(truncated).toContain("...");
    expect(truncated).toContain(ADDRESS.slice(0, 6));
    expect(truncated).toContain(ADDRESS.slice(-4));
  });

  it("returns the mask when masked", () => {
    expect(truncateAddress(ADDRESS, true)).toBe(MASK_ADDRESS);
  });

  it("does not leak the address when masked", () => {
    const masked = truncateAddress(ADDRESS, true);
    expect(masked).not.toContain(ADDRESS.slice(0, 6));
    expect(masked).not.toContain(ADDRESS.slice(-4));
  });

  it("returns the full address for short strings when not masked", () => {
    expect(truncateAddress("short", false)).toBe("short");
  });

  it("returns — for null input", () => {
    expect(truncateAddress(null, false)).toBe("—");
  });
});

// ── formatScore ──────────────────────────────────────────────────────────────

describe("formatScore", () => {
  it("returns the score as string when not masked", () => {
    expect(formatScore(750, false)).toBe("750");
  });

  it("returns the mask when masked", () => {
    expect(formatScore(750, true)).toBe(MASK_SCORE);
  });

  it("does not leak the score in the mask", () => {
    const masked = formatScore(750, true);
    expect(masked).not.toContain("750");
  });

  it("returns — for null", () => {
    expect(formatScore(null, false)).toBe("—");
    expect(formatScore(null, true)).toBe("—");
  });

  it("returns — for undefined", () => {
    expect(formatScore(undefined, false)).toBe("—");
  });

  it("returns — for zero", () => {
    expect(formatScore(0, false)).toBe("—");
  });
});

// ── formatCount ───────────────────────────────────────────────────────────────

describe("formatCount", () => {
  it("returns the count as string when not masked", () => {
    expect(formatCount(42, false)).toBe("42");
  });

  it("returns the mask when masked", () => {
    expect(formatCount(42, true)).toBe(MASK_SCORE);
  });

  it("returns — for null", () => {
    expect(formatCount(null, false)).toBe("—");
  });
});

// ── resolveMaskedValue ────────────────────────────────────────────────────────

describe("resolveMaskedValue", () => {
  it("returns the value when not masked", () => {
    expect(resolveMaskedValue("test-value", false)).toBe("test-value");
  });

  it("returns the mask when masked", () => {
    expect(resolveMaskedValue("test-value", true)).toBe(MASK_BALANCE);
  });

  it("returns — for empty string regardless of mask", () => {
    expect(resolveMaskedValue("", false)).toBe("—");
    expect(resolveMaskedValue("", true)).toBe("—");
  });

  it("returns — for null regardless of mask", () => {
    expect(resolveMaskedValue(null, false)).toBe("—");
    expect(resolveMaskedValue(null, true)).toBe("—");
  });

  it("returns — for undefined regardless of mask", () => {
    expect(resolveMaskedValue(undefined, false)).toBe("—");
    expect(resolveMaskedValue(undefined, true)).toBe("—");
  });

  it("does not leak the value when masked", () => {
    const masked = resolveMaskedValue("sensitive-data", true);
    expect(masked).not.toContain("sensitive");
    expect(masked).not.toContain("data");
  });
});

// ── Mask width is constant regardless of input ────────────────────────────────

describe("mask width is constant regardless of input length", () => {
  it("formatCurrency mask is the same for $1 and $1,000,000", () => {
    expect(formatCurrency(1, true)).toBe(formatCurrency(1000000, true));
  });

  it("formatBalance mask is the same for 0.001 and 999999", () => {
    expect(formatBalance(0.001, true)).toBe(formatBalance(999999, true));
  });

  it("formatAddress mask is the same for short and long addresses", () => {
    expect(formatAddress("GABC", true)).toBe(formatAddress("GVERYLONGADDRESS123", true));
  });

  it("formatScore mask is the same for 300 and 850", () => {
    expect(formatScore(300, true)).toBe(formatScore(850, true));
  });
});
