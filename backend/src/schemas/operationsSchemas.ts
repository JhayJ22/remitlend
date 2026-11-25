import { z } from 'zod';

/**
 * Operations schemas.
 *
 * These schemas define the public contract for operational endpoints covering:
 *  - SLO alert ownership & escalation (#863)
 *  - Production incident evidence bundles (#867)
 *  - Clock skew / timestamp assumptions (#868)
 *
 * Conventions:
 *  - All timestamps are ISO-8601 UTC strings.
 *  - All identifiers are opaque, non-empty strings with bounded length.
 *  - Money units are never represented here; these schemas carry only
 *    operational metadata and references.
 */

const MAX_ID_LENGTH = 256;
const MAX_URL_LENGTH = 2048;
const MAX_TEXT_LENGTH = 4096;

const opaqueId = (field: string) =>
  z
    .string({ required_error: `${field} is required`, invalid_type_error: `${field} must be a string` })
    .trim()
    .min(1, `${field} must not be empty`)
    .max(MAX_ID_LENGTH, `${field} must be at most ${MAX_ID_LENGTH} characters`);

const isoDateTime = (field: string) =>
  z
    .string({ required_error: `${field} is required`, invalid_type_error: `${field} must be a string` })
    .datetime({ offset: true, message: `${field} must be an ISO-8601 timestamp` });

const httpsUrl = (field: string) =>
  z
    .string({ required_error: `${field} is required`, invalid_type_error: `${field} must be a string` })
    .trim()
    .min(1, `${field} must not be empty`)
    .max(MAX_URL_LENGTH, `${field} must be at most ${MAX_URL_LENGTH} characters`)
    .url(`${field} must be a valid URL`)
    .refine((value) => value.startsWith('https://'), {
      message: `${field} must use the https scheme`,
    });

/* -------------------------------------------------------------------------- */
/* #863 Alert ownership & escalation                                          */
/* -------------------------------------------------------------------------- */

export const AlertSeveritySchema = z.enum(['critical', 'high', 'medium', 'low'], {
  errorMap: () => ({
    message: 'severity must be one of: critical, high, medium, low',
  }),
});
export type AlertSeverity = z.infer<typeof AlertSeveritySchema>;

export const EscalationRouteSchema = z.enum(
  ['pagerduty-primary', 'pagerduty-secondary', 'oncall-email', 'slack-finops', 'manual'],
  {
    errorMap: () => ({
      message:
        'escalationRoute must be one of: pagerduty-primary, pagerduty-secondary, oncall-email, slack-finops, manual',
    }),
  },
);
export type EscalationRoute = z.infer<typeof EscalationRouteSchema>;

/**
 * SLO definition reference. The SLO itself is authoritative in the
 * monitoring system; this carries the stable key plus a human-readable
 * description and the numeric target used for alerting.
 */
export const SloDefinitionSchema = z
  .object({
    sloKey: opaqueId('sloDefinition.sloKey'),
    displayName: z
      .string()
      .trim()
      .min(1, 'sloDefinition.displayName must not be empty')
      .max(MAX_TEXT_LENGTH, `sloDefinition.displayName must be at most ${MAX_TEXT_LENGTH} characters`),
    target: z
      .number({ invalid_type_error: 'sloDefinition.target must be a number' })
      .gt(0, 'sloDefinition.target must be greater than 0')
      .lte(1, 'sloDefinition.target must be less than or equal to 1'),
    window: z.enum(['1h', '6h', '24h', '7d', '30d'], {
      errorMap: () => ({
        message: 'sloDefinition.window must be one of: 1h, 6h, 24h, 7d, 30d',
      }),
    }),
    description: z
      .string()
      .trim()
      .max(MAX_TEXT_LENGTH, `sloDefinition.description must be at most ${MAX_TEXT_LENGTH} characters`)
      .optional(),
  })
  .strict();
export type SloDefinition = z.infer<typeof SloDefinitionSchema>;

export const CreateAlertOwnershipSchema = z
  .object({
    sloKey: opaqueId('sloKey'),
    owner: z
      .string({ required_error: 'owner is required', invalid_type_error: 'owner must be a string' })
      .trim()
      .min(1, 'owner must not be empty')
      .max(MAX_ID_LENGTH, `owner must be at most ${MAX_ID_LENGTH} characters`),
    severity: AlertSeveritySchema,
    runbookUrl: httpsUrl('runbookUrl'),
    escalationRoute: EscalationRouteSchema,
    sloDefinition: SloDefinitionSchema,
  })
  .strict();
export type CreateAlertOwnershipInput = z.infer<typeof CreateAlertOwnershipSchema>;

/**
 * Update is a partial patch. At least one mutable field must be present.
 * `sloKey` is immutable and therefore not accepted on update.
 */
export const UpdateAlertOwnershipSchema = z
  .object({
    owner: z
      .string()
      .trim()
      .min(1, 'owner must not be empty')
      .max(MAX_ID_LENGTH, `owner must be at most ${MAX_ID_LENGTH} characters`)
      .optional(),
    severity: AlertSeveritySchema.optional(),
    runbookUrl: httpsUrl('runbookUrl').optional(),
    escalationRoute: EscalationRouteSchema.optional(),
    sloDefinition: SloDefinitionSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided for update',
  });
export type UpdateAlertOwnershipInput = z.infer<typeof UpdateAlertOwnershipSchema>;

export const AlertOwnershipParamsSchema = z
  .object({
    sloKey: opaqueId('sloKey'),
  })
  .strict();
export type AlertOwnershipParams = z.infer<typeof AlertOwnershipParamsSchema>;

/* -------------------------------------------------------------------------- */
/* #863 Drill trigger                                                         */
/* -------------------------------------------------------------------------- */

export const TriggerDrillSchema = z
  .object({
    sloKey: opaqueId('sloKey'),
    /**
     * Client-supplied idempotency key. Replays with the same key must return
     * the original drill result rather than starting a new drill.
     */
    idempotencyKey: z
      .string({
        required_error: 'idempotencyKey is required',
        invalid_type_error: 'idempotencyKey must be a string',
      })
      .trim()
      .min(8, 'idempotencyKey must be at least 8 characters')
      .max(128, 'idempotencyKey must be at most 128 characters')
      .regex(/^[A-Za-z0-9._:-]+$/, 'idempotencyKey contains invalid characters'),
  })
  .strict();
export type TriggerDrillInput = z.infer<typeof TriggerDrillSchema>;

/* -------------------------------------------------------------------------- */
/* #867 Incident evidence bundle                                              */
/* -------------------------------------------------------------------------- */

export const RedactionLevelSchema = z.enum(['default', 'strict', 'none'], {
  errorMap: () => ({
    message: 'redactionLevel must be one of: default, strict, none',
  }),
});
export type RedactionLevel = z.infer<typeof RedactionLevelSchema>;

export const AccessScopeSchema = z.enum(['incident-responders', 'security', 'operations-leads'], {
  errorMap: () => ({
    message: 'accessScope must be one of: incident-responders, security, operations-leads',
  }),
});
export type AccessScope = z.infer<typeof AccessScopeSchema>;

export const CreateIncidentBundleSchema = z
  .object({
    incidentId: opaqueId('incidentId'),
    redactionLevel: RedactionLevelSchema.default('default'),
    accessScope: AccessScopeSchema,
    /**
     * Optional bounded window. When omitted, the server derives the window
     * from the incident record. Bounds are enforced to keep bundles small.
     */
    windowStart: isoDateTime('windowStart').optional(),
    windowEnd: isoDateTime('windowEnd').optional(),
  })
  .strict()
  .refine(
    (value) => {
      if (value.windowStart && value.windowEnd) {
        return new Date(value.windowStart).getTime() <= new Date(value.windowEnd).getTime();
      }
      return true;
    },
    { message: 'windowStart must be before or equal to windowEnd', path: ['windowStart'] },
  );
export type CreateIncidentBundleInput = z.infer<typeof CreateIncidentBundleSchema>;

export const IncidentBundleParamsSchema = z
  .object({
    incidentId: opaqueId('incidentId'),
  })
  .strict();
export type IncidentBundleParams = z.infer<typeof IncidentBundleParamsSchema>;

export const IncidentBundleQuerySchema = z
  .object({
    redactionLevel: RedactionLevelSchema.optional(),
    accessScope: AccessScopeSchema.optional(),
  })
  .strict();
export type IncidentBundleQuery = z.infer<typeof IncidentBundleQuerySchema>;

/* -------------------------------------------------------------------------- */
/* #868 Clock skew sample query                                               */
/* -------------------------------------------------------------------------- */

export const ClockSkewQuerySchema = z
  .object({
    service: z
      .string()
      .trim()
      .min(1, 'service must not be empty')
      .max(MAX_ID_LENGTH, `service must be at most ${MAX_ID_LENGTH} characters`)
      .optional(),
    provider: z
      .string()
      .trim()
      .min(1, 'provider must not be empty')
      .max(MAX_ID_LENGTH, `provider must be at most ${MAX_ID_LENGTH} characters`)
      .optional(),
    from: isoDateTime('from').optional(),
    to: isoDateTime('to').optional(),
    limit: z
      .coerce.number({ invalid_type_error: 'limit must be a number' })
      .int('limit must be an integer')
      .min(1, 'limit must be at least 1')
      .max(1000, 'limit must be at most 1000')
      .default(100),
  })
  .strict()
  .refine(
    (value) => {
      if (value.from && value.to) {
        return new Date(value.from).getTime() <= new Date(value.to).getTime();
      }
      return true;
    },
    { message: 'from must be before or equal to to', path: ['from'] },
  );
export type ClockSkewQuery = z.infer<typeof ClockSkewQuerySchema>;