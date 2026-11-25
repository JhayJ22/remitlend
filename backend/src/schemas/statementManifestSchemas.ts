import { z } from 'zod';

export const STATEMENT_MANIFEST_SCHEMA_VERSION = 'statement-manifest/v1';

export const STATEMENT_SOURCE_TYPES = ['activity', 'wallet_payments', 'loan_events'] as const;

export const STATEMENT_MAX_ROWS = 100_000;
export const STATEMENT_MAX_CHECKPOINT_LENGTH = 256;

const checkpointPattern = /^[A-Za-z0-9:._@/-]+$/;

export const statementManifestRequestSchema = z.object({
  sourceType: z.enum(STATEMENT_SOURCE_TYPES),
  sourceCheckpoint: z
    .string()
    .trim()
    .min(1)
    .max(STATEMENT_MAX_CHECKPOINT_LENGTH)
    .regex(checkpointPattern),
  statementDigest: z.string().regex(/^[a-f0-9]{64}$/),
  rowCount: z.number().int().min(0).max(STATEMENT_MAX_ROWS),
  generatedAt: z.string().datetime(),
});

export type StatementManifestRequest = z.infer<typeof statementManifestRequestSchema>;
export type StatementSourceType = (typeof STATEMENT_SOURCE_TYPES)[number];

export const statementVerificationQuerySchema = z.object({
  sourceType: z.enum(STATEMENT_SOURCE_TYPES).optional(),
});
