import logger from '../utils/logger.js';
import { query } from '../db/connection.js';

export type SorobanQueuedWriteStatus = 'pending' | 'replaying' | 'applied' | 'failed';

export interface SorobanQueuedWrite {
  id: number;
  idempotencyKey: string;
  operation: string;
  payload: Record<string, unknown>;
  status: SorobanQueuedWriteStatus;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface EnqueueSorobanWriteInput {
  idempotencyKey: string;
  operation: string;
  payload: Record<string, unknown>;
}

export interface SorobanWriteQueueStore {
  insert(input: EnqueueSorobanWriteInput): Promise<{
    record: SorobanQueuedWrite;
    inserted: boolean;
  }>;
  listReady(limit: number): Promise<SorobanQueuedWrite[]>;
  markApplied(id: number): Promise<void>;
  markPendingAfterFailure(id: number, error: string, nextAttemptAt: Date): Promise<void>;
  countPending(): Promise<number>;
}

interface SorobanWriteQueueRow {
  id: number;
  idempotency_key: string;
  operation: string;
  payload: Record<string, unknown>;
  status: SorobanQueuedWriteStatus;
  attempts: number;
  last_error: string | null;
  next_attempt_at: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
}

function toRecord(row: SorobanWriteQueueRow): SorobanQueuedWrite {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    operation: row.operation,
    payload: row.payload,
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error,
    nextAttemptAt: new Date(row.next_attempt_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Durable, ordered store for signed Soroban writes that could not be submitted
 * while the RPC endpoint was unavailable (issue #74).
 *
 * Rows live in the `soroban_write_queue` table so a queued write survives a
 * backend restart, and are drained in ascending `id` order by the replay
 * processor. `idempotency_key` is unique so a retried request that enqueues the
 * same signed transaction (same tx hash) is stored exactly once.
 */
export class PgSorobanWriteQueueStore implements SorobanWriteQueueStore {
  async insert(input: EnqueueSorobanWriteInput): Promise<{
    record: SorobanQueuedWrite;
    inserted: boolean;
  }> {
    const result = await query(
      `INSERT INTO soroban_write_queue (idempotency_key, operation, payload)
       VALUES ($1, $2, $3)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      [input.idempotencyKey, input.operation, JSON.stringify(input.payload)],
    );

    const insertedRow = result.rows[0] as SorobanWriteQueueRow | undefined;
    if (insertedRow) {
      return { record: toRecord(insertedRow), inserted: true };
    }

    const existing = await query(
      `SELECT * FROM soroban_write_queue WHERE idempotency_key = $1`,
      [input.idempotencyKey],
    );
    const existingRow = existing.rows[0] as SorobanWriteQueueRow | undefined;
    if (!existingRow) {
      throw new Error(`Failed to enqueue Soroban write ${input.idempotencyKey}`);
    }

    return { record: toRecord(existingRow), inserted: false };
  }

  async listReady(limit: number): Promise<SorobanQueuedWrite[]> {
    const result = await query(
      `SELECT * FROM soroban_write_queue
       WHERE status = 'pending' AND next_attempt_at <= NOW()
       ORDER BY id ASC
       LIMIT $1`,
      [limit],
    );

    return (result.rows as SorobanWriteQueueRow[]).map(toRecord);
  }

  async markApplied(id: number): Promise<void> {
    await query(
      `UPDATE soroban_write_queue
       SET status = 'applied', updated_at = NOW()
       WHERE id = $1`,
      [id],
    );
  }

  async markPendingAfterFailure(
    id: number,
    error: string,
    nextAttemptAt: Date,
  ): Promise<void> {
    await query(
      `UPDATE soroban_write_queue
       SET status = 'pending',
           attempts = attempts + 1,
           last_error = $2,
           next_attempt_at = $3,
           updated_at = NOW()
       WHERE id = $1`,
      [id, error, nextAttemptAt.toISOString()],
    );
  }

  async countPending(): Promise<number> {
    const result = await query(
      `SELECT COUNT(*)::int AS count FROM soroban_write_queue WHERE status = 'pending'`,
    );
    const row = result.rows[0] as { count: number } | undefined;
    return row?.count ?? 0;
  }
}

/**
 * In-memory store used by unit tests and as a last-resort fallback when the
 * database itself is unavailable. Not durable across restarts.
 */
export class InMemorySorobanWriteQueueStore implements SorobanWriteQueueStore {
  private rows: SorobanQueuedWrite[] = [];
  private nextId = 1;

  async insert(input: EnqueueSorobanWriteInput): Promise<{
    record: SorobanQueuedWrite;
    inserted: boolean;
  }> {
    const existing = this.rows.find((row) => row.idempotencyKey === input.idempotencyKey);
    if (existing) {
      return { record: { ...existing }, inserted: false };
    }

    const now = new Date().toISOString();
    const record: SorobanQueuedWrite = {
      id: this.nextId,
      idempotencyKey: input.idempotencyKey,
      operation: input.operation,
      payload: { ...input.payload },
      status: 'pending',
      attempts: 0,
      lastError: null,
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
    };
    this.nextId += 1;
    this.rows.push(record);

    return { record: { ...record }, inserted: true };
  }

  async listReady(limit: number): Promise<SorobanQueuedWrite[]> {
    const now = Date.now();
    return this.rows
      .filter((row) => row.status === 'pending' && new Date(row.nextAttemptAt).getTime() <= now)
      .sort((a, b) => a.id - b.id)
      .slice(0, limit)
      .map((row) => ({ ...row }));
  }

  async markApplied(id: number): Promise<void> {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (row) {
      row.status = 'applied';
      row.updatedAt = new Date().toISOString();
    }
  }

  async markPendingAfterFailure(
    id: number,
    error: string,
    nextAttemptAt: Date,
  ): Promise<void> {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (row) {
      row.status = 'pending';
      row.attempts += 1;
      row.lastError = error;
      row.nextAttemptAt = nextAttemptAt.toISOString();
      row.updatedAt = new Date().toISOString();
    }
  }

  async countPending(): Promise<number> {
    return this.rows.filter((row) => row.status === 'pending').length;
  }
}

/**
 * Queue facade. Storage is injectable so tests (and a degraded-mode fallback)
 * can swap in an in-memory store without touching Redis or Postgres.
 */
export class SorobanWriteQueue {
  private store: SorobanWriteQueueStore;

  constructor(store: SorobanWriteQueueStore = new PgSorobanWriteQueueStore()) {
    this.store = store;
  }

  /** Replace the backing store (tests / degraded-mode fallback). */
  setStore(store: SorobanWriteQueueStore): void {
    this.store = store;
  }

  async enqueue(
    input: EnqueueSorobanWriteInput,
  ): Promise<{ record: SorobanQueuedWrite; duplicate: boolean }> {
    const { record, inserted } = await this.store.insert(input);

    if (inserted) {
      logger.withContext().warn('Queued Soroban write for replay after RPC outage', {
        operation: input.operation,
        idempotencyKey: input.idempotencyKey,
      });
    }

    return { record, duplicate: !inserted };
  }

  async listReadyForReplay(limit: number): Promise<SorobanQueuedWrite[]> {
    return this.store.listReady(limit);
  }

  async markApplied(id: number): Promise<void> {
    await this.store.markApplied(id);
  }

  /** Back off exponentially after a failed replay and return the next attempt time. */
  async markFailed(id: number, error: string, attempts: number): Promise<Date> {
    const nextAttemptAt = new Date(Date.now() + this.backoffMs(attempts));
    await this.store.markPendingAfterFailure(id, error, nextAttemptAt);
    return nextAttemptAt;
  }

  async pendingCount(): Promise<number> {
    return this.store.countPending();
  }

  private backoffMs(attempts: number): number {
    const base = readPositiveInt('SOROBAN_WRITE_BACKOFF_BASE_MS', 5000);
    const max = readPositiveInt('SOROBAN_WRITE_BACKOFF_MAX_MS', 300000);
    return Math.min(base * 2 ** Math.max(0, attempts - 1), max);
  }
}

export const sorobanWriteQueue = new SorobanWriteQueue();
