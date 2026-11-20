import { z } from 'zod';
import { CONSENT_PURPOSES, CONSENT_DATA_CATEGORIES } from '../services/consentLedgerService.js';

export const grantConsentSchema = z
  .object({
    purpose: z.enum(CONSENT_PURPOSES),
    policy_version: z
      .string()
      .regex(/^\d+\.\d+$/, 'policy_version must be in MAJOR.MINOR format (e.g. "1.0")'),
    data_categories: z
      .array(z.enum(CONSENT_DATA_CATEGORIES))
      .min(1, 'At least one data category is required'),
  })
  .strict();

export const revokeConsentSchema = z
  .object({
    purpose: z.enum(CONSENT_PURPOSES),
    revocation_reason: z.string().max(500).optional().nullable(),
  })
  .strict();

export type GrantConsentBody = z.infer<typeof grantConsentSchema>;
export type RevokeConsentBody = z.infer<typeof revokeConsentSchema>;
