import { query } from '../db/connection.js';
import { AppError } from '../errors/AppError.js';
import { ErrorCode } from '../errors/errorCodes.js';

export const ASSET_ALLOWLIST_TTL_MS = 5 * 60 * 1000;

export interface SupportedAsset {
  assetCode: string;
  issuer: string;
  tokenAddress: string;
  decimals: number;
  minLoanAmount: string;
  maxLoanAmount: string;
}

let cache: { assets: Map<string, SupportedAsset>; expiresAt: number } | null = null;

const loadAllowlist = async (): Promise<Map<string, SupportedAsset>> => {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.assets;
  const result = await query(
    `SELECT asset_code, issuer, token_address, decimals,
            min_loan_amount::text AS min_loan_amount, max_loan_amount::text AS max_loan_amount
       FROM supported_assets`,
    [],
  );
  const assets = new Map<string, SupportedAsset>();
  for (const row of result.rows as Array<Record<string, unknown>>) {
    assets.set(String(row.token_address), {
      assetCode: String(row.asset_code),
      issuer: String(row.issuer),
      tokenAddress: String(row.token_address),
      decimals: Number(row.decimals),
      minLoanAmount: String(row.min_loan_amount),
      maxLoanAmount: String(row.max_loan_amount),
    });
  }
  cache = { assets, expiresAt: now + ASSET_ALLOWLIST_TTL_MS };
  return assets;
};

export const invalidateAssetAllowlist = (): void => {
  cache = null;
};

/** Throws 400 ASSET_NOT_SUPPORTED unless the token is on the allowlist (cached 5 min). */
export const assertAssetSupported = async (tokenAddress: string): Promise<SupportedAsset> => {
  const asset = (await loadAllowlist()).get(tokenAddress);
  if (!asset) {
    throw AppError.badRequest('Token is not a supported asset', ErrorCode.ASSET_NOT_SUPPORTED);
  }
  return asset;
};

export const createSupportedAsset = async (input: SupportedAsset): Promise<SupportedAsset> => {
  try {
    await query(
      `INSERT INTO supported_assets
         (asset_code, issuer, token_address, decimals, min_loan_amount, max_loan_amount)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        input.assetCode,
        input.issuer,
        input.tokenAddress,
        input.decimals,
        input.minLoanAmount,
        input.maxLoanAmount,
      ],
    );
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw AppError.badRequest('Asset is already onboarded', ErrorCode.VALIDATION_ERROR);
    }
    throw error;
  }
  invalidateAssetAllowlist();
  return input;
};
