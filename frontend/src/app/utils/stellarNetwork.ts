/**
 * utils/stellarNetwork.ts
 *
 * Single source of truth for Stellar / Soroban network configuration.
 *
 * Network passphrases, RPC URLs and human-readable labels must never be
 * hardcoded in feature code. Import from here so the app can target testnet,
 * futurenet or mainnet purely through environment configuration:
 *
 *   NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE
 *   NEXT_PUBLIC_STELLAR_RPC_URL
 *   NEXT_PUBLIC_STELLAR_NETWORK_LABEL
 *
 * The defaults below only exist so local development against the public
 * Stellar testnet works with zero configuration.
 */

export const DEFAULT_TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
export const DEFAULT_TESTNET_RPC_URL = "https://soroban-testnet.stellar.org";
export const DEFAULT_NETWORK_LABEL = "Stellar Testnet";

/** Network passphrase used when signing/submitting transactions. */
export const STELLAR_NETWORK_PASSPHRASE =
  process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE ?? DEFAULT_TESTNET_PASSPHRASE;

/** Soroban RPC endpoint. */
export const STELLAR_RPC_URL =
  process.env.NEXT_PUBLIC_STELLAR_RPC_URL ?? DEFAULT_TESTNET_RPC_URL;

/** Human-readable network name for display in transaction previews. */
export const STELLAR_NETWORK_LABEL =
  process.env.NEXT_PUBLIC_STELLAR_NETWORK_LABEL ?? DEFAULT_NETWORK_LABEL;
