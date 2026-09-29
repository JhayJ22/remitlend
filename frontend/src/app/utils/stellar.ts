import { StrKey } from "@stellar/stellar-sdk";

const EXPLORER_BASE_URL =
  process.env.NEXT_PUBLIC_STELLAR_EXPLORER_URL ?? "https://stellar.expert/explorer/testnet";

/**
 * Validates if a string is a valid Stellar public key
 * Stellar addresses are 56 characters long, start with 'G', and use base32 encoding
 */
export function isValidStellarAddress(address: string): boolean {
  if (!address || typeof address !== "string") return false;
  return StrKey.isValidEd25519PublicKey(address);
}

export function getTxUrl(txHash: string): string {
  return `${EXPLORER_BASE_URL}/tx/${txHash}`;
}

export function getAccountUrl(address: string): string {
  return `${EXPLORER_BASE_URL}/account/${address}`;
}

export function truncateHash(hash: string, chars = 8): string {
  if (hash.length <= chars * 2 + 3) return hash;
  return `${hash.slice(0, chars)}...${hash.slice(-chars)}`;
}
