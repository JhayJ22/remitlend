/**
 * utils/contractVersion.ts
 *
 * Feature-flagged contract version compatibility.
 *
 * Controls which version of the Soroban contract ABI/API the frontend
 * targets. Set `NEXT_PUBLIC_CONTRACT_VERSION` in your environment to
 * switch between versions without a code change.
 *
 * Supported versions
 * ──────────────────
 * v1  – original contract interface (default; matches all currently deployed
 *        contracts on testnet and mainnet).
 * v2  – next-generation interface with extended loan fields and updated
 *        function signatures. Gate new code paths with `isContractV2()`.
 *
 * Rolling out a new version
 * ─────────────────────────
 * 1. Deploy the updated contract to testnet.
 * 2. Add `NEXT_PUBLIC_CONTRACT_VERSION=v2` to the staging `.env`.
 * 3. Verify, then promote the env flag to production.
 * 4. Remove the v1 code paths once v2 is fully rolled out.
 *
 * Rollback
 * ────────
 * Remove or change `NEXT_PUBLIC_CONTRACT_VERSION` and redeploy. All
 * feature gates read the env at build time, so a rollback is a single
 * env-var change + rebuild.
 *
 * Security / threat-model notes
 * ──────────────────────────────
 * - The version flag is a *build-time* constant (Next.js bakes
 *   `NEXT_PUBLIC_*` vars into the bundle). It does NOT come from
 *   user-supplied input and cannot be overridden at runtime.
 * - Financial arithmetic is always sourced from authoritative on-chain
 *   or backend values; the version flag only selects which ABI path to
 *   call, never which numbers to display.
 */

/** All contract versions the frontend knows about. */
export type ContractVersion = "v1" | "v2";

const RAW_VERSION = (process.env.NEXT_PUBLIC_CONTRACT_VERSION ?? "v1").trim().toLowerCase();

/**
 * The active contract version resolved from `NEXT_PUBLIC_CONTRACT_VERSION`.
 * Falls back to `"v1"` for any unrecognised value, logging a warning in
 * non-production environments so misconfiguration is caught early.
 */
export const CONTRACT_VERSION: ContractVersion = (() => {
  if (RAW_VERSION === "v1" || RAW_VERSION === "v2") {
    return RAW_VERSION as ContractVersion;
  }
  if (process.env.NODE_ENV !== "production") {
    console.warn(
      `[contractVersion] Unknown NEXT_PUBLIC_CONTRACT_VERSION "${RAW_VERSION}". ` +
        `Falling back to "v1". Valid values: "v1", "v2".`,
    );
  }
  return "v1";
})();

/** True when the app is running against the v2 contract interface. */
export function isContractV2(): boolean {
  return CONTRACT_VERSION === "v2";
}

/** True when the app is running against the v1 contract interface (default). */
export function isContractV1(): boolean {
  return CONTRACT_VERSION === "v1";
}

/**
 * Returns the appropriate value based on the active contract version.
 *
 * @example
 * const functionName = contractVersionSwitch({
 *   v1: "request_loan",
 *   v2: "request_loan_v2",
 * });
 */
export function contractVersionSwitch<T>(options: { v1: T; v2: T }): T {
  return CONTRACT_VERSION === "v2" ? options.v2 : options.v1;
}

/**
 * Returns the Soroban function name for requesting a loan,
 * accounting for the active contract version.
 *
 * v1: `request_loan`
 * v2: `request_loan_v2`
 */
export const LOAN_REQUEST_FUNCTION = contractVersionSwitch({
  v1: "request_loan",
  v2: "request_loan_v2",
});

/**
 * Returns the Soroban function name for repaying a loan.
 *
 * v1: `repay`
 * v2: `repay_v2`
 */
export const LOAN_REPAY_FUNCTION = contractVersionSwitch({
  v1: "repay",
  v2: "repay_v2",
});

/**
 * Returns the Soroban function name for depositing into the lending pool.
 *
 * v1: `deposit`
 * v2: `deposit_v2`
 */
export const POOL_DEPOSIT_FUNCTION = contractVersionSwitch({
  v1: "deposit",
  v2: "deposit_v2",
});

/**
 * Returns the Soroban function name for withdrawing from the lending pool.
 *
 * v1: `withdraw`
 * v2: `withdraw_v2`
 */
export const POOL_WITHDRAW_FUNCTION = contractVersionSwitch({
  v1: "withdraw",
  v2: "withdraw_v2",
});
