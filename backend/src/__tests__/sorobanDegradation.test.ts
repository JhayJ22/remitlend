/**
 * Graceful degradation for Soroban RPC failures (#74).
 *
 * Covers the four acceptance-critical behaviours:
 *   - read operations continue during an RPC outage (last known value served),
 *   - write operations are queued (never lost) when the RPC is unavailable,
 *   - queued writes replay in order once the RPC recovers,
 *   - the availability circuit flips status as the health endpoint changes.
 *
 * The RPC server is mocked through `config/stellar.js` so no network call is
 * made, matching the style of `faultInjection.soroban.test.ts`.
 */

import { jest, describe, it, expect, beforeEach, beforeAll } from '@jest/globals';
import request from 'supertest';
import express, { type Request, type Response } from 'express';
import {
  Account,
  Asset,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
} from '@stellar/stellar-sdk';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockGetLatestLedger = jest.fn<() => Promise<{ sequence: number }>>();
const mockGetAccount = jest.fn<() => Promise<unknown>>();
const mockSimulateTransaction = jest.fn<() => Promise<unknown>>();
const mockSendTransaction = jest.fn<() => Promise<unknown>>();
const mockPollTransaction = jest.fn<() => Promise<unknown>>();

const mockRpcServer = {
  getLatestLedger: mockGetLatestLedger,
  getAccount: mockGetAccount,
  simulateTransaction: mockSimulateTransaction,
  prepareTransaction: jest.fn<() => Promise<unknown>>(),
  sendTransaction: mockSendTransaction,
  pollTransaction: mockPollTransaction,
};

jest.unstable_mockModule('../config/stellar.js', () => ({
  createSorobanRpcServer: jest.fn(() => mockRpcServer),
  getStellarNetworkPassphrase: jest.fn(() => 'Test SDF Network ; September 2015'),
  getStellarRpcUrl: jest.fn(() => 'https://soroban-testnet.stellar.org'),
}));

jest.unstable_mockModule('../db/connection.js', () => ({
  default: { query: jest.fn() },
  query: jest.fn(),
  getClient: jest.fn(),
  withTransaction: jest.fn(),
}));

// ─── Module under test ────────────────────────────────────────────────────────

const { sorobanCircuitBreaker } = await import('../services/sorobanCircuitBreaker.js');
const {
  sorobanWriteQueue,
  SorobanWriteQueue,
  InMemorySorobanWriteQueueStore,
} = await import('../services/sorobanWriteQueue.js');
const { sorobanService } = await import('../services/sorobanService.js');
const { runSorobanWriteReplayOnce } = await import('../services/sorobanWriteReplayProcessor.js');
const { sorobanDegradationBanner } = await import('../middleware/sorobanDegradationBanner.js');

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const sourceKeypair = Keypair.random();
const contractId = StrKey.encodeContract(Buffer.alloc(32, 7));
const tokenId = StrKey.encodeContract(Buffer.alloc(32, 9));

function buildSignedTransactionXdr(): string {
  const keypair = Keypair.random();
  const account = new Account(keypair.publicKey(), '1');
  const transaction = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: keypair.publicKey(),
        asset: Asset.native(),
        amount: '1',
      }),
    )
    .setTimeout(30)
    .build();
  transaction.sign(keypair);
  return transaction.toXDR();
}

beforeAll(() => {
  process.env.LOAN_MANAGER_CONTRACT_ID = contractId;
  process.env.LENDING_POOL_CONTRACT_ID = contractId;
  process.env.REMITTANCE_NFT_CONTRACT_ID = contractId;
  process.env.POOL_TOKEN_ADDRESS = tokenId;
  process.env.SCORE_RECONCILIATION_SOURCE_SECRET = sourceKeypair.secret();
});

beforeEach(() => {
  sorobanCircuitBreaker.reset();
  sorobanWriteQueue.setStore(new InMemorySorobanWriteQueueStore());
  mockGetLatestLedger.mockReset();
  mockGetAccount.mockReset();
  mockSimulateTransaction.mockReset();
  mockSendTransaction.mockReset();
  mockPollTransaction.mockReset();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Soroban RPC graceful degradation (#74)', () => {
  describe('availability circuit', () => {
    it('caches the availability status between probes', async () => {
      mockGetLatestLedger.mockResolvedValue({ sequence: 100 });

      await sorobanCircuitBreaker.checkAvailability();
      await sorobanCircuitBreaker.checkAvailability();

      expect(mockGetLatestLedger).toHaveBeenCalledTimes(1);
      expect(sorobanCircuitBreaker.getStatus().available).toBe(true);
    });

    it('flips from down to up as the RPC health endpoint changes', async () => {
      mockGetLatestLedger.mockRejectedValue(new Error('fetch failed: ETIMEDOUT'));

      const first = await sorobanCircuitBreaker.checkAvailability(true);
      expect(first.available).toBe(false);

      await sorobanCircuitBreaker.checkAvailability(true);
      const third = await sorobanCircuitBreaker.checkAvailability(true);
      expect(third.available).toBe(false);
      expect(sorobanCircuitBreaker.getStatus().state).toBe('open');
      expect(sorobanCircuitBreaker.getStatus().degraded).toBe(true);

      mockGetLatestLedger.mockResolvedValue({ sequence: 9001 });

      const recovered = await sorobanCircuitBreaker.checkAvailability(true);
      expect(recovered.available).toBe(true);
      expect(recovered.latestLedger).toBe(9001);
      expect(sorobanCircuitBreaker.getStatus().state).toBe('closed');
      expect(sorobanCircuitBreaker.getStatus().degraded).toBe(false);
    });
  });

  describe('read operations during an outage', () => {
    it('serves the last known value instead of throwing', async () => {
      mockGetAccount.mockResolvedValue(new Account(sourceKeypair.publicKey(), '1'));
      mockSimulateTransaction.mockResolvedValue({
        result: { retval: nativeToScVal(42, { type: 'u32' }) },
      });

      const fresh = await sorobanService.getWithdrawalCooldownLedgers();
      expect(fresh).toBe(42);

      mockGetAccount.mockRejectedValue(new Error('fetch failed: ECONNREFUSED connect timeout'));

      const stale = await sorobanService.getWithdrawalCooldownLedgers();
      expect(stale).toBe(42);
      expect(sorobanCircuitBreaker.getStatus().degraded).toBe(true);
    });
  });

  describe('write operations during an outage', () => {
    it('queues a signed transaction instead of failing hard', async () => {
      sorobanCircuitBreaker.recordFailure(new Error('temporarily unavailable'));
      sorobanCircuitBreaker.recordFailure(new Error('temporarily unavailable'));
      sorobanCircuitBreaker.recordFailure(new Error('temporarily unavailable'));
      expect(sorobanCircuitBreaker.shouldShortCircuit()).toBe(true);

      const signedXdr = buildSignedTransactionXdr();
      const result = await sorobanService.submitSignedTx(signedXdr);

      expect(result.status).toBe('QUEUED');
      expect(result.queued).toBe(true);
      expect(mockSendTransaction).not.toHaveBeenCalled();

      const pending = await sorobanWriteQueue.listReadyForReplay(10);
      expect(pending).toHaveLength(1);
      expect(pending[0]?.operation).toBe('submit_signed_tx');
      expect(pending[0]?.payload.signedTxXdr).toBe(signedXdr);
    });

    it('is idempotent when the same signed transaction is queued twice', async () => {
      sorobanCircuitBreaker.recordFailure(new Error('temporarily unavailable'));
      sorobanCircuitBreaker.recordFailure(new Error('temporarily unavailable'));
      sorobanCircuitBreaker.recordFailure(new Error('temporarily unavailable'));

      const signedXdr = buildSignedTransactionXdr();
      await sorobanService.submitSignedTx(signedXdr);
      await sorobanService.submitSignedTx(signedXdr);

      expect(await sorobanWriteQueue.pendingCount()).toBe(1);
    });
  });

  describe('replay on recovery', () => {
    it('replays queued writes in order once the RPC is available', async () => {
      const queue = new SorobanWriteQueue(new InMemorySorobanWriteQueueStore());
      await queue.enqueue({
        idempotencyKey: 'submit:aaa',
        operation: 'submit_signed_tx',
        payload: { signedTxXdr: 'aaa' },
      });
      await queue.enqueue({
        idempotencyKey: 'submit:bbb',
        operation: 'submit_signed_tx',
        payload: { signedTxXdr: 'bbb' },
      });

      const submitted: string[] = [];
      const result = await runSorobanWriteReplayOnce({
        queue,
        isAvailable: async () => true,
        submit: async (write) => {
          submitted.push(write.idempotencyKey);
        },
      });

      expect(result.skipped).toBe(false);
      expect(result.applied).toBe(2);
      expect(result.failed).toBe(0);
      expect(submitted).toEqual(['submit:aaa', 'submit:bbb']);
      expect(await queue.pendingCount()).toBe(0);
    });

    it('keeps a failed write pending with backoff and preserves ordering', async () => {
      const queue = new SorobanWriteQueue(new InMemorySorobanWriteQueueStore());
      await queue.enqueue({
        idempotencyKey: 'submit:aaa',
        operation: 'submit_signed_tx',
        payload: { signedTxXdr: 'aaa' },
      });
      await queue.enqueue({
        idempotencyKey: 'submit:bbb',
        operation: 'submit_signed_tx',
        payload: { signedTxXdr: 'bbb' },
      });

      const attempted: string[] = [];
      const result = await runSorobanWriteReplayOnce({
        queue,
        isAvailable: async () => true,
        submit: async (write) => {
          attempted.push(write.idempotencyKey);
          if (write.idempotencyKey === 'submit:aaa') {
            throw new Error('still unavailable');
          }
        },
      });

      expect(result.applied).toBe(0);
      expect(result.failed).toBe(1);
      expect(attempted).toEqual(['submit:aaa']);

      // Nothing was lost: both writes are still pending, and the failed one is
      // backed off so only the next write is currently ready.
      expect(await queue.pendingCount()).toBe(2);
      const ready = await queue.listReadyForReplay(10);
      expect(ready.map((write) => write.idempotencyKey)).toEqual(['submit:bbb']);
    });

    it('skips the replay pass while the RPC is still unavailable', async () => {
      const queue = new SorobanWriteQueue(new InMemorySorobanWriteQueueStore());
      await queue.enqueue({
        idempotencyKey: 'submit:aaa',
        operation: 'submit_signed_tx',
        payload: { signedTxXdr: 'aaa' },
      });

      const result = await runSorobanWriteReplayOnce({
        queue,
        isAvailable: async () => false,
        submit: async () => {
          throw new Error('should not be called');
        },
      });

      expect(result.skipped).toBe(true);
      expect(await queue.pendingCount()).toBe(1);
    });
  });

  describe('degradation banner middleware', () => {
    it('adds a warning banner to read responses while degraded', async () => {
      const bannerApp = express();
      bannerApp.use(sorobanDegradationBanner);
      bannerApp.get('/api/v1/pool/cooldown', (_req: Request, res: Response) => {
        res.json({ success: true, cooldown: 42 });
      });

      sorobanCircuitBreaker.recordFailure(new Error('temporarily unavailable'));
      sorobanCircuitBreaker.recordFailure(new Error('temporarily unavailable'));
      sorobanCircuitBreaker.recordFailure(new Error('temporarily unavailable'));

      const response = await request(bannerApp).get('/api/v1/pool/cooldown');

      expect(response.status).toBe(200);
      expect(response.headers['x-soroban-degraded']).toBe('true');
      expect(response.body.degraded).toBe(true);
      expect(response.body.cooldown).toBe(42);
      expect(Array.isArray(response.body.warnings)).toBe(true);
    });
  });
});
