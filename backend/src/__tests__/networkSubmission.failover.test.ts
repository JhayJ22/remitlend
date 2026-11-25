/**
 * Transaction submission telemetry + bounded failover integration (#857).
 *
 * Exercises the wired submit path end to end (mocked RPC + in-memory write
 * queue): a successful submission on the primary endpoint records telemetry;
 * when no endpoint is healthy the signed transaction is queued (never lost);
 * and a write that keeps failing during replay is bounded to the dead-letter
 * store instead of retrying forever. The RPC is mocked through
 * `config/stellar.js`, matching faultInjection.soroban / sorobanDegradation.
 */

import { jest, describe, it, expect, beforeAll, beforeEach } from '@jest/globals';
import {
  Account,
  Asset,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockGetLatestLedger = jest.fn<() => Promise<{ sequence: number }>>();
const mockGetAccount = jest.fn<() => Promise<unknown>>();
const mockSendTransaction = jest.fn<() => Promise<unknown>>();
const mockPollTransaction = jest.fn<() => Promise<unknown>>();

const mockRpcServer = {
  getLatestLedger: mockGetLatestLedger,
  getAccount: mockGetAccount,
  simulateTransaction: jest.fn(),
  prepareTransaction: jest.fn(),
  sendTransaction: mockSendTransaction,
  pollTransaction: mockPollTransaction,
};

jest.unstable_mockModule('../config/stellar.js', () => ({
  createSorobanRpcServer: jest.fn(() => mockRpcServer),
  getStellarNetworkPassphrase: jest.fn(() => Networks.TESTNET),
  getStellarRpcUrl: jest.fn(() => 'https://soroban-testnet.stellar.org'),
}));

jest.unstable_mockModule('../db/connection.js', () => ({
  default: { query: jest.fn(async () => ({ rows: [] })) },
  query: jest.fn(async () => ({ rows: [] })),
  getClient: jest.fn(),
  withTransaction: jest.fn(),
}));

// ─── Module under test ────────────────────────────────────────────────────────

const { sorobanCircuitBreaker } = await import('../services/sorobanCircuitBreaker.js');
const { resetNetworkRegistry } = await import('../config/networks.js');
const {
  sorobanWriteQueue,
  SorobanWriteQueue,
  InMemorySorobanWriteQueueStore,
} = await import('../services/sorobanWriteQueue.js');
const { sorobanService } = await import('../services/sorobanService.js');
const { runSorobanWriteReplayOnce } = await import('../services/sorobanWriteReplayProcessor.js');
const { getNetworkTelemetrySnapshot } = await import('../services/networkTelemetryService.js');
const { resetRetryStormState } = await import('../services/retryStormAlertService.js');

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function buildSignedTransactionXdr(): string {
  const keypair = Keypair.random();
  const account = new Account(keypair.publicKey(), '1');
  const transaction = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({ destination: keypair.publicKey(), asset: Asset.native(), amount: '1' }),
    )
    .setTimeout(30)
    .build();
  transaction.sign(keypair);
  return transaction.toXDR();
}

beforeAll(() => {
  process.env.STELLAR_NETWORK = 'testnet';
});

beforeEach(() => {
  sorobanCircuitBreaker.reset();
  resetNetworkRegistry();
  resetRetryStormState();
  sorobanWriteQueue.setStore(new InMemorySorobanWriteQueueStore());
  mockGetLatestLedger.mockReset();
  mockGetAccount.mockReset();
  mockSendTransaction.mockReset();
  mockPollTransaction.mockReset();
});

describe('Transaction submission telemetry + bounded failover (#857)', () => {
  it('successful path: submits on the primary endpoint and records telemetry', async () => {
    mockSendTransaction.mockResolvedValue({ hash: 'deadbeef', status: 'PENDING' });
    mockPollTransaction.mockResolvedValue({
      status: 'SUCCESS',
      resultXdr: { toXDR: () => 'base64result' },
    });

    const result = await sorobanService.submitSignedTx(buildSignedTransactionXdr());

    expect(result.status).toBe('SUCCESS');
    expect(result.resultXdr).toBe('base64result');
    expect(mockSendTransaction).toHaveBeenCalledTimes(1);

    const snapshot = await getNetworkTelemetrySnapshot();
    const primary = snapshot.networks.find((n) => n.networkId === 'testnet')!;
    expect(primary.attemptCount).toBeGreaterThanOrEqual(1);
    expect(snapshot.stormAlertActive).toBe(false);
  });

  it('all endpoints down: queues the signed transaction (never lost) without hitting the RPC', async () => {
    for (let i = 0; i < 3; i += 1) sorobanCircuitBreaker.recordFailure(new Error('rpc down'));

    const signedXdr = buildSignedTransactionXdr();
    const result = await sorobanService.submitSignedTx(signedXdr);

    expect(result.status).toBe('QUEUED');
    expect(result.queued).toBe(true);
    expect(mockSendTransaction).not.toHaveBeenCalled();

    const pending = await sorobanWriteQueue.listReadyForReplay(10);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.payload.signedTxXdr).toBe(signedXdr);
  });

  it('idempotency: queuing the same signed transaction twice stores it once', async () => {
    for (let i = 0; i < 3; i += 1) sorobanCircuitBreaker.recordFailure(new Error('rpc down'));

    const signedXdr = buildSignedTransactionXdr();
    await sorobanService.submitSignedTx(signedXdr);
    await sorobanService.submitSignedTx(signedXdr);

    expect(await sorobanWriteQueue.pendingCount()).toBe(1);
  });

  it('bounded replay: a persistently failing write is dead-lettered instead of retrying forever', async () => {
    process.env.TX_SUBMISSION_MAX_ATTEMPTS = '1';
    const queue = new SorobanWriteQueue(new InMemorySorobanWriteQueueStore());
    await queue.enqueue({
      idempotencyKey: 'submit:doomed',
      operation: 'submit_signed_tx',
      payload: { signedTxXdr: 'xdr' },
    });

    const failingSubmit = jest.fn(async () => {
      throw new Error('rpc still down');
    });

    // One replay pass with a ceiling of 1 dead-letters immediately, so the
    // replay loop can never retry a stuck write forever.
    await runSorobanWriteReplayOnce({
      queue,
      submit: failingSubmit,
      isAvailable: async () => true,
    });
    expect(await queue.deadLetterCount()).toBe(1);
    expect(await queue.pendingCount()).toBe(0);

    delete process.env.TX_SUBMISSION_MAX_ATTEMPTS;
  });
});
