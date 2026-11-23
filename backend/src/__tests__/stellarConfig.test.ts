import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Networks } from '@stellar/stellar-sdk';
import { getStellarConfig } from '../config/stellar.js';

const mockQuery = jest.fn<(sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>>();
jest.unstable_mockModule('../db/connection.js', () => ({ query: mockQuery, getClient: jest.fn() }));

const { assertAssetSupported, invalidateAssetAllowlist, createSupportedAsset } = await import(
  '../services/assetAllowlistService.js'
);
const { sorobanService } = await import('../services/sorobanService.js');

const ALLOWED = 'C' + 'A'.repeat(55);
const row = {
  asset_code: 'USDC',
  issuer: 'G' + 'A'.repeat(55),
  token_address: ALLOWED,
  decimals: 7,
  min_loan_amount: '1',
  max_loan_amount: '1000',
};

const originalStellarEnv = {
  STELLAR_NETWORK: process.env.STELLAR_NETWORK,
  STELLAR_RPC_URL: process.env.STELLAR_RPC_URL,
  STELLAR_NETWORK_PASSPHRASE: process.env.STELLAR_NETWORK_PASSPHRASE,
};

const restoreEnv = () => {
  if (originalStellarEnv.STELLAR_NETWORK === undefined) {
    delete process.env.STELLAR_NETWORK;
  } else {
    process.env.STELLAR_NETWORK = originalStellarEnv.STELLAR_NETWORK;
  }

  if (originalStellarEnv.STELLAR_RPC_URL === undefined) {
    delete process.env.STELLAR_RPC_URL;
  } else {
    process.env.STELLAR_RPC_URL = originalStellarEnv.STELLAR_RPC_URL;
  }

  if (originalStellarEnv.STELLAR_NETWORK_PASSPHRASE === undefined) {
    delete process.env.STELLAR_NETWORK_PASSPHRASE;
  } else {
    process.env.STELLAR_NETWORK_PASSPHRASE = originalStellarEnv.STELLAR_NETWORK_PASSPHRASE;
  }
};

afterEach(() => {
  restoreEnv();
});

describe('stellar config', () => {
  it('defaults to testnet settings when env vars are absent', () => {
    delete process.env.STELLAR_NETWORK;
    delete process.env.STELLAR_RPC_URL;
    delete process.env.STELLAR_NETWORK_PASSPHRASE;

    const config = getStellarConfig();

    expect(config.network).toBe('testnet');
    expect(config.rpcUrl).toBe('https://soroban-testnet.stellar.org');
    expect(config.networkPassphrase).toBe(Networks.TESTNET);
  });

  it('uses mainnet defaults when STELLAR_NETWORK=mainnet', () => {
    process.env.STELLAR_NETWORK = 'mainnet';
    delete process.env.STELLAR_RPC_URL;
    delete process.env.STELLAR_NETWORK_PASSPHRASE;

    const config = getStellarConfig();

    expect(config.network).toBe('mainnet');
    expect(config.rpcUrl).toBe('https://soroban-mainnet.stellar.org');
    expect(config.networkPassphrase).toBe(Networks.PUBLIC);
  });

  it('rejects passphrase/network mismatches', () => {
    process.env.STELLAR_NETWORK = 'mainnet';
    process.env.STELLAR_NETWORK_PASSPHRASE = Networks.TESTNET;

    expect(() => getStellarConfig()).toThrow(
      'STELLAR_NETWORK_PASSPHRASE does not match STELLAR_NETWORK="mainnet"',
    );
  });

  it('rejects rpc url/network mismatches', () => {
    process.env.STELLAR_NETWORK = 'mainnet';
    process.env.STELLAR_RPC_URL = 'https://soroban-testnet.stellar.org';

    expect(() => getStellarConfig()).toThrow(
      'STELLAR_RPC_URL appears to target testnet while STELLAR_NETWORK is "mainnet".',
    );
  });
});

describe('asset allowlist enforcement', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [row] });
    invalidateAssetAllowlist();
  });

  it('accepts an allowlisted token and rejects others with ASSET_NOT_SUPPORTED', async () => {
    await expect(assertAssetSupported(ALLOWED)).resolves.toMatchObject({ assetCode: 'USDC' });
    await expect(assertAssetSupported('C' + 'B'.repeat(55))).rejects.toMatchObject({
      statusCode: 400,
      errorCode: 'ASSET_NOT_SUPPORTED',
    });
  });

  it('rejects non-allowlisted tokens on pool deposit and loan approval', async () => {
    const bad = 'C' + 'B'.repeat(55);
    await expect(sorobanService.buildDepositTx('GX', bad, 10)).rejects.toMatchObject({
      errorCode: 'ASSET_NOT_SUPPORTED',
    });
    await expect(sorobanService.buildApproveLoanTx('GX', 1, bad)).rejects.toMatchObject({
      errorCode: 'ASSET_NOT_SUPPORTED',
    });
  });

  it('caches the allowlist (one DB lookup within the TTL)', async () => {
    await assertAssetSupported(ALLOWED);
    await assertAssetSupported(ALLOWED);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const now = Date.now();
    const spy = jest.spyOn(Date, 'now').mockReturnValue(now + 5 * 60 * 1000 + 1);
    await assertAssetSupported(ALLOWED);
    spy.mockRestore();
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('creating an asset inserts a record and invalidates the cache', async () => {
    await assertAssetSupported(ALLOWED);
    await createSupportedAsset({
      assetCode: 'USDC',
      issuer: row.issuer,
      tokenAddress: ALLOWED,
      decimals: 7,
      minLoanAmount: '1',
      maxLoanAmount: '1000',
    });
    expect(mockQuery.mock.calls[1]![0]).toMatch(/INSERT INTO supported_assets/);
    await assertAssetSupported(ALLOWED);
    expect(mockQuery).toHaveBeenCalledTimes(3);
  });
});
