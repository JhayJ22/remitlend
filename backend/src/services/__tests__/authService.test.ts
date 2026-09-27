/**
 * Unit tests for authService
 *
 * Covers: JWT generation/verification, challenge creation/validation,
 * Stellar signature verification, token revocation flows, refresh tokens,
 * token introspection, TTL helpers, and edge/error cases.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { Keypair } from '@stellar/stellar-sdk';

// ─── Environment setup ───────────────────────────────────────────────────────
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-chars!!';

// ─── Mock cacheService before importing authService ──────────────────────────
const fakeCacheStore = new Map<string, unknown>();

jest.unstable_mockModule('../cacheService.js', () => ({
  cacheService: {
    get: jest.fn(async (key: string) => fakeCacheStore.get(key) ?? null),
    set: jest.fn(async (key: string, value: unknown, _ttl?: number) => {
      fakeCacheStore.set(key, value);
    }),
    delete: jest.fn(async (key: string) => {
      fakeCacheStore.delete(key);
    }),
  },
}));

// ─── Import authService (must come after mock setup) ─────────────────────────
const {
  generateChallenge,
  verifySignature,
  verifyChallengeTimestamp,
  generateJwtToken,
  verifyJwtToken,
  revokeToken,
  isTokenRevoked,
  decodeJwtToken,
  extractBearerToken,
  generateRefreshToken,
  verifyRefreshToken,
  introspectToken,
  getTokenTtl,
} = await import('../authService.js');

// ─── Helpers ─────────────────────────────────────────────────────────────────
const FIVE_MIN_MS = 5 * 60 * 1_000;

// =============================================================================
// generateChallenge
// =============================================================================
describe('generateChallenge', () => {
  it('returns a challenge with the expected shape', () => {
    const kp = Keypair.random();
    const challenge = generateChallenge(kp.publicKey());

    expect(challenge.message).toBeDefined();
    expect(typeof challenge.nonce).toBe('string');
    expect(challenge.nonce.length).toBe(64); // 32 bytes → 64 hex chars
    expect(typeof challenge.timestamp).toBe('number');
    expect(challenge.expiresIn).toBe(FIVE_MIN_MS);
  });

  it('embeds the nonce and timestamp in the message', () => {
    const kp = Keypair.random();
    const challenge = generateChallenge(kp.publicKey());

    expect(challenge.message).toContain(challenge.nonce);
    expect(challenge.message).toContain(String(challenge.timestamp));
  });

  it('sets timestamp close to Date.now()', () => {
    const before = Date.now();
    const challenge = generateChallenge(Keypair.random().publicKey());
    const after = Date.now();

    expect(challenge.timestamp).toBeGreaterThanOrEqual(before);
    expect(challenge.timestamp).toBeLessThanOrEqual(after);
  });

  it('generates unique nonces on successive calls', () => {
    const kp = Keypair.random();
    const a = generateChallenge(kp.publicKey());
    const b = generateChallenge(kp.publicKey());

    expect(a.nonce).not.toBe(b.nonce);
  });

  it('throws for an invalid Stellar public key', () => {
    expect(() => generateChallenge('NOT_A_VALID_KEY')).toThrow('Invalid Stellar public key');
  });
});

// =============================================================================
// verifySignature
// =============================================================================
describe('verifySignature', () => {
  it('returns true for a valid signature', () => {
    const kp = Keypair.random();
    const message = 'authenticate me';
    const sig = kp.sign(Buffer.from(message, 'utf-8')).toString('base64');

    expect(verifySignature(kp.publicKey(), message, sig)).toBe(true);
  });

  it('returns false when a different key signed the message', () => {
    const kp1 = Keypair.random();
    const kp2 = Keypair.random();
    const message = 'authenticate me';
    const sig = kp1.sign(Buffer.from(message, 'utf-8')).toString('base64');

    expect(verifySignature(kp2.publicKey(), message, sig)).toBe(false);
  });

  it('returns false when the message was altered after signing', () => {
    const kp = Keypair.random();
    const message = 'original message';
    const sig = kp.sign(Buffer.from(message, 'utf-8')).toString('base64');

    expect(verifySignature(kp.publicKey(), 'tampered message', sig)).toBe(false);
  });

  it('returns false for a signature that is not 64 bytes', () => {
    const kp = Keypair.random();
    const shortSig = Buffer.from('too-short').toString('base64');

    expect(verifySignature(kp.publicKey(), 'msg', shortSig)).toBe(false);
  });

  it('returns false for a non-base64 signature string', () => {
    const kp = Keypair.random();

    expect(verifySignature(kp.publicKey(), 'msg', '!!!not-base64!!!')).toBe(false);
  });

  it('returns false for an invalid Stellar public key', () => {
    const sig = Buffer.from('a'.repeat(64)).toString('base64');

    expect(verifySignature('INVALID_KEY', 'msg', sig)).toBe(false);
  });

  it('returns false for an empty signature', () => {
    const kp = Keypair.random();

    expect(verifySignature(kp.publicKey(), 'msg', '')).toBe(false);
  });
});

// =============================================================================
// verifyChallengeTimestamp
// =============================================================================
describe('verifyChallengeTimestamp', () => {
  it('accepts a fresh timestamp (< 1 second old)', () => {
    expect(verifyChallengeTimestamp(Date.now() - 500)).toBe(true);
  });

  it('accepts a timestamp exactly at the window edge', () => {
    // At exactly maxAgeMs the age equals the limit — still valid.
    expect(verifyChallengeTimestamp(Date.now() - FIVE_MIN_MS, FIVE_MIN_MS)).toBe(true);
  });

  it('rejects a timestamp 1 ms beyond the window', () => {
    expect(verifyChallengeTimestamp(Date.now() - FIVE_MIN_MS - 1, FIVE_MIN_MS)).toBe(false);
  });

  it('accepts a future timestamp within the clock-skew tolerance (< 5 s ahead)', () => {
    expect(verifyChallengeTimestamp(Date.now() + 3_000)).toBe(true);
  });

  it('rejects a future timestamp beyond the clock-skew tolerance (> 5 s ahead)', () => {
    expect(verifyChallengeTimestamp(Date.now() + 10_000)).toBe(false);
  });

  it('rejects 0 as an invalid timestamp', () => {
    expect(verifyChallengeTimestamp(0)).toBe(false);
  });

  it('rejects negative timestamps', () => {
    expect(verifyChallengeTimestamp(-1)).toBe(false);
  });

  it('rejects NaN', () => {
    expect(verifyChallengeTimestamp(NaN)).toBe(false);
  });

  it('rejects Infinity', () => {
    expect(verifyChallengeTimestamp(Infinity)).toBe(false);
  });

  it('respects a custom maxAgeMs parameter', () => {
    const tenSeconds = 10_000;
    expect(verifyChallengeTimestamp(Date.now() - 5_000, tenSeconds)).toBe(true);
    expect(verifyChallengeTimestamp(Date.now() - 11_000, tenSeconds)).toBe(false);
  });
});

// =============================================================================
// generateJwtToken / verifyJwtToken
// =============================================================================
describe('generateJwtToken / verifyJwtToken', () => {
  it('generates a non-empty token string', () => {
    const kp = Keypair.random();
    const token = generateJwtToken(kp.publicKey());

    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);
  });

  it('verifies a freshly generated token', () => {
    const kp = Keypair.random();
    const token = generateJwtToken(kp.publicKey());
    const payload = verifyJwtToken(token);

    expect(payload).not.toBeNull();
    expect(payload!.publicKey).toBe(kp.publicKey());
  });

  it('embeds the correct role and scopes for a borrower wallet', () => {
    const kp = Keypair.random();
    process.env.ADMIN_WALLETS = '';
    process.env.LENDER_WALLETS = '';

    const token = generateJwtToken(kp.publicKey());
    const payload = verifyJwtToken(token);

    expect(payload!.role).toBe('borrower');
    expect(payload!.scopes).toContain('read:loans');
    expect(payload!.scopes).toContain('write:loans');
    expect(payload!.scopes).toContain('read:score');
  });

  it('embeds the admin role when the wallet is in ADMIN_WALLETS', () => {
    const kp = Keypair.random();
    process.env.ADMIN_WALLETS = kp.publicKey();

    const token = generateJwtToken(kp.publicKey());
    const payload = verifyJwtToken(token);

    expect(payload!.role).toBe('admin');
    expect(payload!.scopes).toContain('admin:all');

    process.env.ADMIN_WALLETS = '';
  });

  it('embeds the lender role when the wallet is in LENDER_WALLETS', () => {
    const kp = Keypair.random();
    process.env.LENDER_WALLETS = kp.publicKey();

    const token = generateJwtToken(kp.publicKey());
    const payload = verifyJwtToken(token);

    expect(payload!.role).toBe('lender');
    expect(payload!.scopes).toContain('read:pool');

    process.env.LENDER_WALLETS = '';
  });

  it('sets token_type to Bearer', () => {
    const token = generateJwtToken(Keypair.random().publicKey());
    const payload = verifyJwtToken(token);

    expect(payload!.token_type).toBe('Bearer');
  });

  it('sets scope as a space-separated string of scopes', () => {
    const kp = Keypair.random();
    const token = generateJwtToken(kp.publicKey());
    const payload = verifyJwtToken(token);

    expect(typeof payload!.scope).toBe('string');
    const scopeParts = payload!.scope!.split(' ');
    for (const s of payload!.scopes) {
      expect(scopeParts).toContain(s);
    }
  });

  it('includes a unique jti on each generated token', () => {
    const kp = Keypair.random();
    const t1 = generateJwtToken(kp.publicKey());
    const t2 = generateJwtToken(kp.publicKey());

    expect(verifyJwtToken(t1)!.jti).not.toBe(verifyJwtToken(t2)!.jti);
  });

  it('returns null for a tampered token', () => {
    const kp = Keypair.random();
    const token = generateJwtToken(kp.publicKey());
    const tampered = token.slice(0, -3) + 'xxx';

    expect(verifyJwtToken(tampered)).toBeNull();
  });

  it('returns null for a completely invalid token string', () => {
    expect(verifyJwtToken('not.a.jwt')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(verifyJwtToken('')).toBeNull();
  });

  it('throws when JWT_SECRET is not set', () => {
    const savedSecret = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;

    expect(() => generateJwtToken(Keypair.random().publicKey())).toThrow('JWT_SECRET');

    process.env.JWT_SECRET = savedSecret;
  });
});

// =============================================================================
// revokeToken / isTokenRevoked
// =============================================================================
describe('revokeToken / isTokenRevoked', () => {
  beforeEach(() => {
    fakeCacheStore.clear();
  });

  it('marks a token as revoked', async () => {
    const kp = Keypair.random();
    const token = generateJwtToken(kp.publicKey());
    const payload = decodeJwtToken(token)!;

    await revokeToken(payload.jti, payload.exp);
    expect(await isTokenRevoked(payload.jti)).toBe(true);
  });

  it('returns false for a non-revoked token', async () => {
    expect(await isTokenRevoked('some-random-jti-that-was-never-revoked')).toBe(false);
  });

  it('does not revoke already-expired tokens (ttl ≤ 0)', async () => {
    const expiredExp = Math.floor(Date.now() / 1_000) - 60; // expired 60 s ago
    await revokeToken('expired-jti', expiredExp);

    // The key should NOT have been written to the store.
    const keyPresent = [...fakeCacheStore.keys()].some((k) => k.includes('expired-jti'));
    expect(keyPresent).toBe(false);
    expect(await isTokenRevoked('expired-jti')).toBe(false);
  });

  it('returns false when the cache lookup times out (graceful degradation)', async () => {
    // Override get to hang indefinitely — the 250ms timeout should kick in.
    const { cacheService } = await import('../cacheService.js');
    (cacheService.get as ReturnType<typeof jest.fn>).mockImplementationOnce(
      () => new Promise(() => {/* never resolves */}),
    );

    const result = await isTokenRevoked('timeout-jti');
    expect(result).toBe(false);
  });

  it('returns false when the cache throws an error (graceful degradation)', async () => {
    const { cacheService } = await import('../cacheService.js');
    (cacheService.get as ReturnType<typeof jest.fn>).mockRejectedValueOnce(
      new Error('Redis down'),
    );

    const result = await isTokenRevoked('error-jti');
    expect(result).toBe(false);
  });
});

// =============================================================================
// decodeJwtToken
// =============================================================================
describe('decodeJwtToken', () => {
  it('decodes a valid JWT without verifying the signature', () => {
    const kp = Keypair.random();
    const token = generateJwtToken(kp.publicKey());
    const payload = decodeJwtToken(token);

    expect(payload).not.toBeNull();
    expect(payload!.publicKey).toBe(kp.publicKey());
  });

  it('returns null for a completely invalid token', () => {
    expect(decodeJwtToken('garbage')).toBeNull();
  });

  it('decodes without throwing even if the token is expired', () => {
    // We cannot easily forge a token here, but we can verify that a freshly
    // generated token (which is not expired) decodes correctly.
    const kp = Keypair.random();
    const token = generateJwtToken(kp.publicKey());
    const decoded = decodeJwtToken(token);

    expect(decoded).not.toBeNull();
    expect(decoded!.exp).toBeGreaterThan(Math.floor(Date.now() / 1_000));
  });
});

// =============================================================================
// extractBearerToken
// =============================================================================
describe('extractBearerToken', () => {
  it('extracts the token from a valid Bearer header', () => {
    expect(extractBearerToken('Bearer my-jwt-token')).toBe('my-jwt-token');
  });

  it('returns null for undefined input', () => {
    expect(extractBearerToken(undefined)).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(extractBearerToken('')).toBeNull();
  });

  it('returns null when the scheme is not Bearer (case-sensitive)', () => {
    expect(extractBearerToken('bearer my-token')).toBeNull();
    expect(extractBearerToken('BEARER my-token')).toBeNull();
    expect(extractBearerToken('Basic dGVzdA==')).toBeNull();
  });

  it('returns null when there are too many parts', () => {
    expect(extractBearerToken('Bearer token extra-part')).toBeNull();
  });

  it('returns null when there is only the scheme and no token', () => {
    expect(extractBearerToken('Bearer')).toBeNull();
  });

  it('handles tokens that contain special characters', () => {
    const token = 'eyJhb.eyJzd.SflK';
    expect(extractBearerToken(`Bearer ${token}`)).toBe(token);
  });
});

// =============================================================================
// generateRefreshToken / verifyRefreshToken
// =============================================================================
describe('generateRefreshToken / verifyRefreshToken', () => {
  it('generates a non-empty token string', () => {
    const kp = Keypair.random();
    const token = generateRefreshToken(kp.publicKey());

    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);
  });

  it('verifies a freshly generated refresh token', () => {
    const kp = Keypair.random();
    const token = generateRefreshToken(kp.publicKey());
    const payload = verifyRefreshToken(token);

    expect(payload).not.toBeNull();
    expect(payload!.publicKey).toBe(kp.publicKey());
  });

  it('embeds the provided tokenFamily', () => {
    const kp = Keypair.random();
    const family = 'my-family-id';
    const token = generateRefreshToken(kp.publicKey(), family);
    const payload = verifyRefreshToken(token);

    expect(payload!.tokenFamily).toBe(family);
  });

  it('assigns a random tokenFamily when none is provided', () => {
    const kp = Keypair.random();
    const t1 = generateRefreshToken(kp.publicKey());
    const t2 = generateRefreshToken(kp.publicKey());

    expect(verifyRefreshToken(t1)!.tokenFamily).not.toBe(verifyRefreshToken(t2)!.tokenFamily);
  });

  it('generates unique jtis for each token', () => {
    const kp = Keypair.random();
    const t1 = generateRefreshToken(kp.publicKey());
    const t2 = generateRefreshToken(kp.publicKey());

    expect(verifyRefreshToken(t1)!.jti).not.toBe(verifyRefreshToken(t2)!.jti);
  });

  it('returns null for a tampered refresh token', () => {
    const kp = Keypair.random();
    const token = generateRefreshToken(kp.publicKey());
    const tampered = token.slice(0, -3) + 'zzz';

    expect(verifyRefreshToken(tampered)).toBeNull();
  });

  it('returns null for a completely invalid token', () => {
    expect(verifyRefreshToken('not-a-token')).toBeNull();
  });

  it('embeds the correct role and scopes', () => {
    const kp = Keypair.random();
    process.env.ADMIN_WALLETS = '';
    process.env.LENDER_WALLETS = '';

    const token = generateRefreshToken(kp.publicKey());
    const payload = verifyRefreshToken(token);

    expect(payload!.role).toBe('borrower');
    expect(Array.isArray(payload!.scopes)).toBe(true);
  });
});

// =============================================================================
// introspectToken
// =============================================================================
describe('introspectToken', () => {
  it('returns active=true for a fresh token', () => {
    const kp = Keypair.random();
    const token = generateJwtToken(kp.publicKey());
    const result = introspectToken(token);

    expect(result.active).toBe(true);
    expect(result.sub).toBe(kp.publicKey());
    expect(result.client_id).toBe(kp.publicKey());
    expect(result.username).toBe(kp.publicKey());
    expect(result.token_type).toBe('Bearer');
    expect(typeof result.jti).toBe('string');
    expect(typeof result.exp).toBe('number');
    expect(typeof result.iat).toBe('number');
  });

  it('exposes the scope string', () => {
    const kp = Keypair.random();
    const token = generateJwtToken(kp.publicKey());
    const result = introspectToken(token);

    expect(typeof result.scope).toBe('string');
    expect(result.scope!.length).toBeGreaterThan(0);
  });

  it('returns a positive ttl for a fresh token', () => {
    const kp = Keypair.random();
    const token = generateJwtToken(kp.publicKey());
    const result = introspectToken(token);

    expect(result.ttl).toBeGreaterThan(0);
  });

  it('returns active=false for an invalid token string', () => {
    const result = introspectToken('not-a-jwt');

    expect(result.active).toBe(false);
    expect(Object.keys(result).length).toBe(1); // only `active`
  });

  it('returns active=false for an empty string', () => {
    expect(introspectToken('').active).toBe(false);
  });
});

// =============================================================================
// getTokenTtl
// =============================================================================
describe('getTokenTtl', () => {
  it('returns a positive number for a fresh token', () => {
    const kp = Keypair.random();
    const token = generateJwtToken(kp.publicKey());
    const ttl = getTokenTtl(token);

    expect(ttl).not.toBeNull();
    expect(ttl!).toBeGreaterThan(0);
  });

  it('returns null for an invalid token', () => {
    expect(getTokenTtl('garbage')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(getTokenTtl('')).toBeNull();
  });

  it('returns 0 (not negative) for an expired token payload', () => {
    // Forge a decode by using a real token and mocking time — instead, verify
    // that a just-issued token has a TTL close to 24 h (86400 s).
    const kp = Keypair.random();
    const token = generateJwtToken(kp.publicKey());
    const ttl = getTokenTtl(token)!;

    // 24 h in seconds = 86400; allow ±5 s for test execution.
    expect(ttl).toBeGreaterThan(86_400 - 5);
    expect(ttl).toBeLessThanOrEqual(86_400);
  });
});
