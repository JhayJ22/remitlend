import { z } from 'zod';

// Schema for GET /score/:userId
export const getScoreSchema = z.object({
  params: z.object({
    userId: z.string().min(1).max(100),
  }),
});

// Schema for GET /score/confidence/filter
export const filterByConfidenceSchema = z.object({
  query: z.object({
    minConfidence: z
      .string()
      .optional()
      .transform((v) => (v ? parseFloat(v) : 0.6))
      .refine((v) => v >= 0 && v <= 1, 'Confidence must be between 0 and 1'),
    lenderIds: z
      .string()
      .optional()
      .transform((v) => (v ? v.split(',') : undefined)),
  }),
});

// Schema for GET /score/:walletAddress/history
export const getScoreHistorySchema = z.object({
  params: z.object({
    walletAddress: z.string().min(1).max(100),
  }),
});

// Schema for GET /score/:walletAddress/nft
export const getRemittanceNftSchema = z.object({
  params: z.object({
    walletAddress: z.string().min(1).max(100),
  }),
});

// Schema for POST /score/update
export const updateScoreSchema = z.object({
  body: z.object({
    userId: z.string().min(1).max(100),
    repaymentAmount: z
      .number()
      .positive('Repayment amount must be positive')
      .max(1_000_000, 'Repayment amount exceeds maximum limit'),
    onTime: z.boolean({
      message: 'onTime must be a boolean',
    }),
  }),
});

// TypeScript types
export type GetScoreInput = z.infer<typeof getScoreSchema>;
export type GetScoreHistoryInput = z.infer<typeof getScoreHistorySchema>;
export type GetRemittanceNftInput = z.infer<typeof getRemittanceNftSchema>;
export type UpdateScoreInput = z.infer<typeof updateScoreSchema>;
