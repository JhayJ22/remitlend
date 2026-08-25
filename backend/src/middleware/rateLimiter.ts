import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

/**
 * Rate limiter → endpoint mapping (see issue #44).
 *
 * All limiters are keyed per-IP by default; login also keys on the wallet
 * public key so a single IP cannot brute-force many distinct wallets.
 *
 *   challengeRateLimiter   → POST   /api/auth/challenge
 *   loginRateLimiter       → POST   /api/auth/login        (keyed by IP + pubkey)
 *   ipLoginRateLimiter     → POST   /api/auth/login        (keyed by IP)
 *   verifyRateLimiter      → GET    /api/auth/verify
 *   strictRateLimiter      → admin routes (disputes, indexer, webhooks)
 *   globalRateLimiter      → (reserved) general API guard
 *   simulationRateLimiter  → simulation routes (skipped in test env)
 */
export const createRateLimiter = (max: number, windowMinutes: number = 15) =>
  rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    max,
    message: { error: 'Too many requests, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
  });

export const globalRateLimiter = createRateLimiter(100);
export const strictRateLimiter = createRateLimiter(10, 45);

// Auth endpoints: 10 req/min per IP (stricter rate limiting for brute-force protection)
export const challengeRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? 'unknown'),
  message: {
    success: false,
    message: 'Too many challenge requests, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res, _next, options) => {
    res.setHeader('Retry-After', Math.ceil(options.windowMs / 1000));
    res.status(429).json(options.message);
  },
});

export const loginRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5,
  keyGenerator: (req) =>
    `${ipKeyGenerator(req.ip ?? 'unknown')}:${req.body?.publicKey ?? 'unknown'}`,
  message: {
    success: false,
    message: 'Too many login attempts, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res, _next, options) => {
    res.setHeader('Retry-After', Math.ceil(options.windowMs / 1000));
    res.status(429).json(options.message);
  },
});

export const ipLoginRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5,
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? 'unknown'),
  message: {
    success: false,
    message: 'Too many login attempts from this IP, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res, _next, options) => {
    res.setHeader('Retry-After', Math.ceil(options.windowMs / 1000));
    res.status(429).json(options.message);
  },
});

export const verifyRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? 'unknown'),
  message: { success: false, message: 'Too many verification attempts' },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res, _next, options) => {
    res.setHeader('Retry-After', Math.ceil(options.windowMs / 1000));
    res.status(429).json(options.message);
  },
});

// Simulation endpoints: 5 req/min per authenticated user
export const simulationRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5,
  keyGenerator: (req) => {
    // Use authenticated user's public key if available, otherwise fall back to IP
    const user = (req as unknown as { user?: { publicKey: string } }).user;
    return user?.publicKey ?? ipKeyGenerator(req.ip ?? 'unknown');
  },
  message: {
    success: false,
    message: 'Too many simulation requests, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  handler: (_req, res, _next, options) => {
    res.setHeader('Retry-After', Math.ceil(options.windowMs / 1000));
    res.status(429).json(options.message);
  },
});
