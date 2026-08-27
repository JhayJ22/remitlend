/**
 * Runtime API Response Validator
 * 
 * Validates API responses against generated Zod schemas to catch
 * contract drift at runtime in development/staging environments.
 */

import { z, ZodSchema, ZodError } from "zod";

interface ValidationResult<T> {
  success: boolean;
  data?: T;
  error?: {
    message: string;
    issues: ZodError["issues"];
    path: string;
    method: string;
    statusCode: number;
  };
}

interface ApiValidatorOptions {
  enabled?: boolean;
  logErrors?: boolean;
  throwOnError?: boolean;
}

class ApiValidator {
  private schemas: Map<string, ZodSchema> = new Map();
  private options: Required<ApiValidatorOptions>;

  constructor(options: ApiValidatorOptions = {}) {
    this.options = {
      enabled: process.env.NODE_ENV !== "production",
      logErrors: true,
      throwOnError: false,
      ...options,
    };
  }

  /**
   * Register a Zod schema for a specific API endpoint
   */
  registerSchema(endpointKey: string, schema: ZodSchema): void {
    this.schemas.set(endpointKey, schema);
  }

  /**
   * Register multiple schemas at once
   */
  registerSchemas(schemas: Record<string, ZodSchema>): void {
    for (const [key, schema] of Object.entries(schemas)) {
      this.registerSchema(key, schema);
    }
  }

  /**
   * Validate an API response against its schema
   */
  validate<T>(
    endpointKey: string,
    response: unknown,
    context: { path: string; method: string; statusCode: number }
  ): ValidationResult<T> {
    if (!this.options.enabled) {
      return { success: true, data: response as T };
    }

    const schema = this.schemas.get(endpointKey);
    if (!schema) {
      // No schema registered, skip validation
      return { success: true, data: response as T };
    }

    try {
      const validatedData = schema.parse(response);
      return { success: true, data: validatedData };
    } catch (error) {
      if (error instanceof ZodError) {
        const validationError = {
          message: `API contract validation failed for ${context.method} ${context.path}`,
          issues: error.issues,
          path: context.path,
          method: context.method,
          statusCode: context.statusCode,
        };

        if (this.options.logErrors) {
          console.error("🔴 API Contract Violation:", validationError);
          console.error("Response:", JSON.stringify(response, null, 2));
        }

        if (this.options.throwOnError) {
          throw new ApiContractError(validationError);
        }

        return { success: false, error: validationError };
      }

      throw error;
    }
  }

  /**
   * Create a fetch wrapper that automatically validates responses
   */
  createValidatedFetch() {
    return async (
      endpointKey: string,
      url: string,
      options?: RequestInit
    ): Promise<Response> => {
      const response = await fetch(url, options);
      
      // Clone response to read body twice
      const responseClone = response.clone();
      
      try {
        const data = await response.json();
        const validation = this.validate(endpointKey, data, {
          path: url,
          method: options?.method || "GET",
          statusCode: response.status,
        });

        if (!validation.success && this.options.throwOnError) {
          throw new ApiContractError(validation.error!);
        }
      } catch (error) {
        if (error instanceof ApiContractError) throw error;
        // If not an ApiContractError, rethrow
        throw error;
      }

      return response;
    };
  }

  /**
   * Get all registered endpoint keys
   */
  getRegisteredEndpoints(): string[] {
    return Array.from(this.schemas.keys());
  }

  /**
   * Clear all registered schemas
   */
  clear(): void {
    this.schemas.clear();
  }
}

class ApiContractError extends Error {
  public readonly validationError: ValidationResult<any>["error"];

  constructor(validationError: ValidationResult<any>["error"]) {
    super(validationError?.message || "API contract validation failed");
    this.name = "ApiContractError";
    this.validationError = validationError!;
  }
}

// Singleton instance for global use
export const apiValidator = new ApiValidator({
  enabled: process.env.NODE_ENV !== "production",
  logErrors: true,
  throwOnError: false,
});

// Helper to create endpoint keys consistently
export function createEndpointKey(path: string, method: string): string {
  return `${method.toUpperCase()}:${path.replace(/[^a-zA-Z0-9/]/g, "").replace(/\//g, ".")}`;
}

// Middleware for TanStack Query to auto-validate
export function createValidationMiddleware(validator: ApiValidator = apiValidator) {
  return {
    onSuccess: (data: any, variables: any, context: any) => {
      // Extract endpoint info from query key or variables
      // This would need to be customized based on your query key structure
    },
    onError: (error: any, variables: any, context: any) => {
      // Handle validation errors
    },
  };
}

// React Query plugin for automatic validation
export function createReactQueryValidationPlugin(validator: ApiValidator = apiValidator) {
  return {
    mutationCache: {
      onSuccess: (data: any, variables: any, context: any) => {
        // Could validate mutation responses here
      },
    },
    queryCache: {
      onSuccess: (data: any, query: any) => {
        // Could validate query responses here
        // Need to map query keys to endpoint keys
      },
    },
  };
}

export { ApiValidator, ApiContractError, type ValidationResult, type ApiValidatorOptions };