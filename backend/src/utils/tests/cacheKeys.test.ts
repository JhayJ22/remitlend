import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mockDelete = jest.fn<(key: string) => Promise<void>>().mockResolvedValue(undefined);

jest.unstable_mockModule('../../services/cacheService.js', () => ({
  cacheService: {
    get: jest.fn(async () => null),
    set: jest.fn(async () => undefined),
    delete: mockDelete,
    ping: jest.fn(async () => 'ok'),
    invalidatePattern: jest.fn(async () => undefined),
  },
}));

const { CacheKeys, SCORE_CACHE_VERSION, invalidateOnScoreUpdate } = await import('../cacheKeys.js');

describe('CacheKeys format stability', () => {
  beforeEach(() => {
    mockDelete.mockClear();
  });

  it('poolStats', () => {
    expect(CacheKeys.poolStats()).toBe('pool:stats');
  });

  it('borrowerLoans', () => {
    expect(CacheKeys.borrowerLoans('GBORROWER123')).toBe('borrower:loans:GBORROWER123');
  });

  it('scoreResponse embeds the schema version and user id', () => {
    expect(CacheKeys.scoreResponse('GPUBKEY456')).toBe(
      `score:response:v${SCORE_CACHE_VERSION}:GPUBKEY456`,
    );
  });

  it('scoreBreakdown embeds the schema version and public key', () => {
    expect(CacheKeys.scoreBreakdown('GPUBKEY456')).toBe(
      `score:breakdown:v${SCORE_CACHE_VERSION}:GPUBKEY456`,
    );
  });

  it('legacy score keys keep the pre-versioning format for flushing', () => {
    expect(CacheKeys.legacyScoreResponse('GPUBKEY456')).toBe('score:userId:GPUBKEY456');
    expect(CacheKeys.legacyScoreBreakdown('GPUBKEY456')).toBe('score:breakdown:GPUBKEY456');
  });

  it('pendingLoanTx', () => {
    expect(CacheKeys.pendingLoanTx('GBORROWER789', 5000)).toBe('pending_loan_tx:GBORROWER789:5000');
  });

  it('pendingRepayTx', () => {
    expect(CacheKeys.pendingRepayTx('GBORROWER789', 42, 2500)).toBe(
      'pending_repay_tx:GBORROWER789:42:2500',
    );
  });

  it('pendingDepositTx', () => {
    expect(CacheKeys.pendingDepositTx('GDEPOSITOR111', 'USDC', 10000)).toBe(
      'pending_deposit_tx:GDEPOSITOR111:USDC:10000',
    );
  });

  it('pendingWithdrawTx', () => {
    expect(CacheKeys.pendingWithdrawTx('GDEPOSITOR111', 'USDC', 5000)).toBe(
      'pending_withdraw_tx:GDEPOSITOR111:USDC:5000',
    );
  });
});

describe('invalidateOnScoreUpdate', () => {
  it('flushes the versioned and legacy score read keys for the user', async () => {
    await invalidateOnScoreUpdate('GPUBKEY456');

    const deletedKeys = mockDelete.mock.calls.map((call) => call[0]);
    expect(deletedKeys).toContain(CacheKeys.scoreResponse('GPUBKEY456'));
    expect(deletedKeys).toContain(CacheKeys.scoreBreakdown('GPUBKEY456'));
    expect(deletedKeys).toContain('score:userId:GPUBKEY456');
    expect(deletedKeys).toContain('score:breakdown:GPUBKEY456');
  });

  it('does not touch another user\u2019s keys', async () => {
    await invalidateOnScoreUpdate('GPUBKEY456');

    const deletedKeys = mockDelete.mock.calls.map((call) => call[0]);
    expect(deletedKeys).toHaveLength(4);
    expect(deletedKeys.every((key) => key.includes('GPUBKEY456'))).toBe(true);
  });
});
