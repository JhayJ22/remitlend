/**
 * Bounded dead-letter behaviour for the Soroban write queue (#857).
 *
 * Covers the boundary between bounded retry and dead-lettering (attempts ==
 * max → dead-lettered; attempts < max → rescheduled), re-drive idempotency,
 * and the depth counters — using the in-memory store so no database is needed.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import {
  SorobanWriteQueue,
  InMemorySorobanWriteQueueStore,
} from '../sorobanWriteQueue.js';

describe('SorobanWriteQueue — bounded dead-letter', () => {
  let queue: SorobanWriteQueue;

  beforeEach(() => {
    queue = new SorobanWriteQueue(new InMemorySorobanWriteQueueStore());
  });

  it('enqueues with the configured bounded max-attempts and starts pending', async () => {
    const { record } = await queue.enqueue({
      idempotencyKey: 'submit:abc',
      operation: 'submit_signed_tx',
      payload: { signedTxXdr: 'xdr' },
    });

    expect(record.status).toBe('pending');
    expect(record.attempts).toBe(0);
    expect(record.maxAttempts).toBe(10);
    expect(record.deadLetteredAt).toBeNull();
  });

  it('does not dead-letter while attempts remain below the ceiling', async () => {
    const { record } = await queue.enqueue({
      idempotencyKey: 'submit:abc',
      operation: 'submit_signed_tx',
      payload: { signedTxXdr: 'xdr' },
    });

    let write = record;
    for (let next = 1; next < write.maxAttempts; next += 1) {
      // Boundary: the next attempt number is still below the ceiling.
      expect(queue.shouldDeadLetter(write, next)).toBe(false);
      await queue.markFailed(write.id, 'transient rpc error', next);
      // Still pending (rescheduled with backoff), never dead-lettered.
      expect(await queue.deadLetterCount()).toBe(0);
      expect(await queue.pendingCount()).toBe(1);
      // Carry the configured ceiling forward for the next comparison.
      write = { ...write, attempts: next };
    }
  });

  it('dead-letters once attempts reach the bounded ceiling, preserving the signed payload', async () => {
    const { record } = await queue.enqueue({
      idempotencyKey: 'submit:dead',
      operation: 'submit_signed_tx',
      payload: { signedTxXdr: 'immutable-xdr' },
    });

    // Drive to the ceiling (maxAttempts) and assert the boundary flips.
    expect(queue.shouldDeadLetter(record, record.maxAttempts)).toBe(true);

    await queue.markDeadLetter(record.id, 'exhausted 10 bounded attempts: persistent outage');

    const deadLetters = await queue.listDeadLetters(10);
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0]!.id).toBe(record.id);
    expect(deadLetters[0]!.status).toBe('dead_lettered');
    expect(deadLetters[0]!.deadLetteredAt).not.toBeNull();
    expect(deadLetters[0]!.deadLetterReason).toContain('exhausted');
    // The immutable signed payload is preserved for re-drive.
    expect(deadLetters[0]!.payload.signedTxXdr).toBe('immutable-xdr');

    expect(await queue.deadLetterCount()).toBe(1);
    // Dead-lettered writes are excluded from automatic replay.
    expect(await queue.listReadyForReplay(10)).toHaveLength(0);
  });

  it('re-drives a dead-lettered write (idempotent reset) so the replay loop can retry it', async () => {
    const { record } = await queue.enqueue({
      idempotencyKey: 'submit:redrive',
      operation: 'submit_signed_tx',
      payload: { signedTxXdr: 'xdr' },
    });

    await queue.markDeadLetter(record.id, 'exhausted');
    expect(await queue.deadLetterCount()).toBe(1);
    expect(await queue.pendingCount()).toBe(0);

    await queue.redrive(record.id);

    expect(await queue.deadLetterCount()).toBe(0);
    expect(await queue.pendingCount()).toBe(1);
    const ready = await queue.listReadyForReplay(10);
    const revived = ready.find((w) => w.id === record.id)!;
    expect(revived.status).toBe('pending');
    expect(revived.attempts).toBe(0);
    expect(revived.deadLetteredAt).toBeNull();
    expect(revived.deadLetterReason).toBeNull();
  });

  it('re-drive is a no-op on a non-dead-lettered write (no partial side effects)', async () => {
    const { record } = await queue.enqueue({
      idempotencyKey: 'submit:nodl',
      operation: 'submit_signed_tx',
      payload: { signedTxXdr: 'xdr' },
    });

    // A pending write is not affected by redrive.
    await queue.redrive(record.id);
    expect(await queue.pendingCount()).toBe(1);
    expect(await queue.deadLetterCount()).toBe(0);
  });
});
