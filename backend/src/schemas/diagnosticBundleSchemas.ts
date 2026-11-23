import { z } from 'zod';

const nonEmpty = z.string().trim().min(1).max(512);

export const diagnosticBundleCreateSchema = z.object({
  confirm: z.literal(true),
});

export const diagnosticBundleParamsSchema = z.object({
  transactionRef: nonEmpty,
  bundleId: nonEmpty.optional(),
});

export const diagnosticBundleResponseSchema = z.object({
  id: z.string(),
  expiresAt: z.string().datetime(),
});

export type DiagnosticBundleCreateInput = z.infer<typeof diagnosticBundleCreateSchema>;
export type DiagnosticBundleParams = z.infer<typeof diagnosticBundleParamsSchema>;
