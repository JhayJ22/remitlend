import { z } from 'zod';

export const ABUSE_MUTATION_TYPES = [
  'loan_request',
  'loan_repay',
  'loan_submit',
  'loan_deposit_collateral',
  'loan_release_collateral',
  'loan_refinance',
  'loan_extend',
  'loan_liquidate',
  'remittance_create',
  'remittance_submit',
] as const;

export const ABUSE_DECISIONS = ['allow', 'block'] as const;
export const ABUSE_OUTCOMES = ['success', 'failure', 'blocked'] as const;
export const ABUSE_RISK_TIERS = ['low', 'medium', 'high'] as const;
export const ABUSE_RATE_BANDS = ['one', 'few', 'many', 'burst'] as const;

export type AbuseMutationType = (typeof ABUSE_MUTATION_TYPES)[number];
export type AbuseDecision = (typeof ABUSE_DECISIONS)[number];
export type AbuseOutcome = (typeof ABUSE_OUTCOMES)[number];
export type AbuseRiskTier = (typeof ABUSE_RISK_TIERS)[number];
export type AbuseRateBand = (typeof ABUSE_RATE_BANDS)[number];

export const actorHashSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, 'actorHash must be a 64-char lowercase hex digest');

export const abuseTelemetryEventSchema = z.object({
  eventId: z.string().uuid(),
  actorHash: actorHashSchema,
  mutationType: z.enum(ABUSE_MUTATION_TYPES),
  decision: z.enum(ABUSE_DECISIONS),
  outcome: z.enum(ABUSE_OUTCOMES),
  riskTier: z.enum(ABUSE_RISK_TIERS),
  rateBand: z.enum(ABUSE_RATE_BANDS),
  attemptsInWindow: z.number().int().min(1).max(10000),
  occurredAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});

export type AbuseTelemetryEvent = z.infer<typeof abuseTelemetryEventSchema>;

export const abuseTelemetryPublicEventSchema = abuseTelemetryEventSchema.omit({
  actorHash: true,
  eventId: true,
  expiresAt: true,
});

export type AbuseTelemetryPublicEvent = z.infer<typeof abuseTelemetryPublicEventSchema>;

export const abuseTelemetryQuerySchema = z.object({
  mutationType: z.enum(ABUSE_MUTATION_TYPES).optional(),
  outcome: z.enum(ABUSE_OUTCOMES).optional(),
  riskTier: z.enum(ABUSE_RISK_TIERS).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type AbuseTelemetryQuery = z.infer<typeof abuseTelemetryQuerySchema>;

export const DEFAULT_ABUSE_TELEMETRY_RETENTION_DAYS = 30;
export const ABUSE_TELEMETRY_BLOCK_THRESHOLD = 20;
export const ABUSE_TELEMETRY_WINDOW_MS = 60_000;
