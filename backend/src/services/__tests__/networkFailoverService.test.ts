/**
 * Bounded network failover for transaction submission (#857).
 *
 * Covers: selecting the healthy primary by default, bounded failover to a
 * same-passphrase endpoint when the primary trips, the hop bound limiting
 * how far failover reaches, rejection of endpoints that target a different
 * network (passphrase correctness), and NoHealthyEndpointError when every
 * considered endpoint is short-circuiting.
 *
 * The database is mocked (failover events are best-effort) and breakers are
 * driven in-memory so no RPC call is made.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

jest.unstable_mockModule('../../db/connection.js', () => ({
  default: { query: jest.fn(async () => ({ rows: [] })) },
  query: jest.fn(async () => ({ rows: [] })),
  getClient: jest.fn(),
  withTransaction: jest.fn(),
}));

const { sorobanCircuitBreaker } = await import('../sorobanCircuitBreaker.js');
const {
  resetNetworkRegistry,
  listNetworkEndpoints,
  getActiveNetworkEndpointId,
} = await import('../../config/networks.js');
const {
  selectEndpointForSubmission,
  recordEndpointFailure,
  NoHealthyEndpointError,
} = await import('../networkFailoverService.js');

const FAILOVER_ENV = JSON.stringify([
  { label: 'failover-eu', rpcUrl: 'https://soroban-testnet-failover.example.org', priority: 1 },
]);

function failOpen() {
  // Open the primary breaker by recording enough consecutive failures.
  for (let i = 0; i < 3; i += 1) {
    recordEndpointFailure('testnet', new Error(`rpc failure ${i}`));
  }
}

describe('Network failover service (#857)', () => {
  beforeEach(() => {
    sorobanCircuitBreaker.reset();
    resetNetworkRegistry();
    process.env.STELLAR_FAILOVER_NETWORKS = FAILOVER_ENV;
    process.env.STELLAR_NETWORK = 'testnet';
    process.env.TX_SUBMISSION_MAX_FAILOVER_HOPS = '3';
  });

  afterEach(() => {
    delete process.env.STELLAR_FAILOVER_NETWORKS;
    delete process.env.TX_SUBMISSION_MAX_FAILOVER_HOPS;
  });

  it('selects the healthy primary endpoint by default', () => {
    const selected = selectEndpointForSubmission();
    expect(selected.endpointId).toBe('testnet');
    expect(getActiveNetworkEndpointId()).toBe('testnet');
  });

  it('fails over to the next same-passphrase endpoint when the primary trips', () => {
    failOpen();

    const selected = selectEndpointForSubmission();
    expect(selected.endpointId).toBe('failover-failover-eu');
    expect(getActiveNetworkEndpointId()).toBe('failover-failover-eu');
  });

  it('bounds failover: with max hops of 1 a tripped primary cannot reach the failover endpoint', () => {
    process.env.TX_SUBMISSION_MAX_FAILOVER_HOPS = '1';
    failOpen();

    expect(() => selectEndpointForSubmission()).toThrow(NoHealthyEndpointError);
  });

  it('throws NoHealthyEndpointError when every considered endpoint is short-circuiting', () => {
    failOpen();
    // Trip the failover endpoint's breaker too.
    for (let i = 0; i < 3; i += 1) {
      recordEndpointFailure('failover-failover-eu', new Error(`failover failure ${i}`));
    }

    expect(() => selectEndpointForSubmission()).toThrow(NoHealthyEndpointError);
  });

  it('rejects failover endpoints that appear to target a different network (passphrase correctness)', () => {
    // Primary is testnet; a failover URL containing 'mainnet' is rejected so a
    // signed (testnet-bound) transaction is never relayed to the mainnet network.
    process.env.STELLAR_FAILOVER_NETWORKS = JSON.stringify([
      { label: 'wrong-net', rpcUrl: 'https://soroban-mainnet.example.org', priority: 1 },
    ]);

    expect(listNetworkEndpoints()).toHaveLength(1);
    expect(listNetworkEndpoints()[0]!.id).toBe('testnet');
  });

  it('fails back to the primary automatically once it recovers', () => {
    failOpen();
    expect(selectEndpointForSubmission().endpointId).toBe('failover-failover-eu');

    // Primary recovers: reset + record a success to close the breaker.
    sorobanCircuitBreaker.reset();
    sorobanCircuitBreaker.recordSuccess();

    expect(selectEndpointForSubmission().endpointId).toBe('testnet');
  });
});
