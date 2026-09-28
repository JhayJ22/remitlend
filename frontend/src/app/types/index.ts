/**
 * app/types/index.ts
 *
 * Single import point for all API-derived types in the RemitLend frontend.
 *
 * WHY THIS EXISTS (#351)
 * ───────────────────────
 * Previously, API response shapes were declared as hand-written TypeScript
 * interfaces scattered across useApi.ts and other modules. This created two
 * problems:
 *
 *  1. Contract drift — hand-written types silently diverge from the backend
 *     as the API evolves, causing runtime shape mismatches that TypeScript
 *     cannot catch.
 *
 *  2. Duplication — the same shape was re-declared in multiple files, making
 *     refactors error-prone.
 *
 * The fix is a generated source of truth:
 *
 *  - `api.generated.ts` is produced by `npm run generate:api-types`, which
 *    reads the backend's live OpenAPI spec and emits typed interfaces via
 *    `openapi-typescript`.
 *  - This barrel (index.ts) re-exports those generated types under stable
 *    names so application code never imports from the raw generated file.
 *  - All new type references in the app should come from `@/app/types`, not
 *    from hand-written declarations in feature modules.
 *
 * USAGE
 * ─────
 * ```ts
 * import type { ApiLoan, ApiRemittance, ApiPoolStats } from "@/app/types";
 * ```
 *
 * KEEPING TYPES IN SYNC
 * ──────────────────────
 * 1. Start the backend: `npm run dev` (from /backend).
 * 2. Run `npm run generate:api-types` from /frontend.
 * 3. Commit the updated `api.generated.ts`.
 * 4. CI will run `npm run validate:api-contract` to flag breaking drift.
 *
 * BACKWARD COMPATIBILITY
 * ───────────────────────
 * The hand-written interfaces in useApi.ts remain as type aliases that
 * point to the generated types. Existing code continues to compile; only
 * new code is required to import from `@/app/types` directly.
 */

import type { components } from "./api.generated";

// ─── Re-export generated component schemas ────────────────────────────────────

/** Alias for the full components.schemas namespace — useful for advanced usage. */
export type ApiSchemas = components["schemas"];

/** A loan resource as returned by the API. */
export type ApiLoan = components["schemas"]["Loan"];

/** A remittance resource as returned by the API. */
export type ApiRemittance = components["schemas"]["Remittance"];

/** Authenticated user profile. */
export type ApiUserProfile = components["schemas"]["UserProfile"];

/** User wallet balance. */
export type ApiUserBalance = components["schemas"]["UserBalance"];

/** Credit score response. */
export type ApiCreditScoreResponse = components["schemas"]["CreditScoreResponse"];

/** Lending pool statistics. */
export type ApiPoolStats = components["schemas"]["PoolStats"];

/** A depositor's portfolio in the lending pool. */
export type ApiDepositorPortfolio = components["schemas"]["DepositorPortfolio"];

/** An in-app notification. */
export type ApiAppNotification = components["schemas"]["AppNotification"];

/** Auth session validation response. */
export type ApiAuthSession = components["schemas"]["AuthSession"];

/** Cursor-based pagination metadata. */
export type ApiCursorPageInfo = components["schemas"]["CursorPageInfo"];

/**
 * Loan status values as a union type.
 * Derived from the generated schema so it always matches the API.
 */
export type ApiLoanStatus = components["schemas"]["Loan"]["status"];

/**
 * Notification type values as a union type.
 * Derived from the generated schema so it always matches the API.
 */
export type ApiNotificationType = components["schemas"]["AppNotification"]["type"];

/**
 * User role values.
 * Derived from the generated schema so it always matches the API.
 */
export type ApiUserRole = NonNullable<components["schemas"]["AuthSession"]["role"]>;

/**
 * Generic paginated list result.
 * Wraps any item type with cursor pagination metadata.
 */
export interface ApiPaginatedResult<T> {
  items: T[];
  pageInfo: ApiCursorPageInfo;
}
