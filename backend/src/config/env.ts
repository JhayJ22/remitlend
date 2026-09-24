import logger from '../utils/logger.js';
import { validateEnvSchema } from './envSchema.js';

/**
 * @deprecated Use `validateEnvSchema()` from `./envSchema.ts` instead.
 *
 * This function is kept for backward compatibility. It now delegates to the
 * Zod-powered schema validator introduced in issue #413, which provides richer
 * type coercion, range checking, and structured error reporting.
 *
 * Calling `validateEnvVars()` is equivalent to calling `validateEnvSchema()`;
 * both terminate the process on any validation failure.
 */
export function validateEnvVars(): void {
  validateEnvSchema();
  logger.info('Environment variables validated successfully.');
}

export { validateEnvSchema } from './envSchema.js';
export { getEnv } from './envSchema.js';
