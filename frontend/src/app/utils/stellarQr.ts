const G_ADDRESS = /^G[A-Z2-7]{55}$/;

export function isStellarGAddress(value: string): boolean {
  return G_ADDRESS.test(value.trim());
}

/**
 * Extract a Stellar G-address from a scanned QR payload. Supports a raw address
 * and SEP-7 URIs (`web+stellar:pay?destination=G...&amount=...`). Returns null
 * when the payload does not carry a valid G-address.
 */
export function parseStellarQrPayload(payload: string): string | null {
  const text = payload.trim();
  if (isStellarGAddress(text)) return text;

  if (/^web\+stellar:/i.test(text)) {
    const queryStart = text.indexOf("?");
    if (queryStart === -1) return null;
    const destination = new URLSearchParams(text.slice(queryStart + 1)).get("destination");
    if (destination && isStellarGAddress(destination)) return destination.trim();
  }
  return null;
}

/** Mask a value for display, keeping a short prefix and suffix. */
export function maskValue(value: string, head = 4, tail = 4): string {
  if (value.length <= head + tail) return "•".repeat(value.length);
  return `${value.slice(0, head)}••••${value.slice(-tail)}`;
}
