import { randomUUID } from 'node:crypto';
import { query, type PoolClient } from '../db/connection.js';
import logger from '../utils/logger.js';

/**
 * Domain event types appended to the append-only `loan_state_events` table.
 * These intentionally share the vocabulary used by the on-chain contract
 * events so a single reducer can replay both sources.
 */
export const LOAN_STATE_EVENT_TYPES = [
  'LoanRequested',
  'LoanApproved',
  'LoanRepaid',
  'LoanDefaulted',
  'LoanCancelled',
  'LoanRejected',
  'LoanRefinanced',
  'LoanExtended',
  'LoanLiquidated',
  'CollateralLiquidated',
  'LoanDisputed',
  'CollateralDeposited',
  'CollateralReleased',
] as const;

export type LoanStateEventType = (typeof LOAN_STATE_EVENT_TYPES)[number];

export interface LoanStateEvent {
  id: number;
  eventId: string;
  loanId: number;
  eventType: string;
  payload: Record<string, unknown>;
  actor: string | null;
  occurredAt: Date;
  createdAt: Date;
}

export interface EmitLoanStateEventInput {
  /** Explicit unique id for idempotent emission (e.g. derived from a source event). */
  eventId?: string;
  loanId: number;
  eventType: string;
  payload?: Record<string, unknown>;
  actor?: string | null;
  occurredAt?: Date;
}

export interface ReplaySnapshot {
  loanId: number;
  status:
    | 'unknown'
    | 'requested'
    | 'active'
    | 'repaid'
    | 'defaulted'
    | 'liquidated'
    | 'disputed'
    | 'cancelled'
    | 'rejected';
  principal: number;
  totalRepaid: number;
  approved: boolean;
  defaulted: boolean;
  disputed: boolean;
  liquidated: boolean;
  cancelled: boolean;
  rejected: boolean;
  eventCount: number;
  firstEventAt: string | null;
  lastEventAt: string | null;
  events: Array<{
    eventType: string;
    payload: Record<string, unknown>;
    actor: string | null;
    occurredAt: string;
  }>;
}

/**
 * Append a single loan state transition to the append-only event log.
 *
 * When `client` is provided the insert runs inside that caller's transaction
 * (used by the event indexer so on-chain transitions are captured atomically
 * with the raw event insert). Otherwise a standalone `query` is used.
 *
 * Idempotent: an explicit `eventId` that already exists is ignored.
 */
export const emitLoanStateEvent = async (
  input: EmitLoanStateEventInput,
  client?: PoolClient,
): Promise<LoanStateEvent | null> => {
  const eventId = input.eventId ?? `lse_${randomUUID()}`;
  const payload = input.payload ?? {};
  const occurredAt = input.occurredAt ?? new Date();

  const executor = client ?? { query };
  const result = await executor.query(
    `INSERT INTO loan_state_events (event_id, loan_id, event_type, payload, actor, occurred_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING id, event_id, loan_id, event_type, payload, actor, occurred_at, created_at`,
    [
      eventId,
      input.loanId,
      input.eventType,
      JSON.stringify(payload),
      input.actor ?? null,
      occurredAt,
    ],
  );

  if ((result.rowCount ?? 0) === 0) {
    return null;
  }

  const row = result.rows[0] as Record<string, unknown>;
  return {
    id: Number(row.id),
    eventId: row.event_id as string,
    loanId: Number(row.loan_id),
    eventType: row.event_type as string,
    payload: (row.payload as Record<string, unknown>) ?? {},
    actor: (row.actor as string | null) ?? null,
    occurredAt: new Date(row.occurred_at as string),
    createdAt: new Date(row.created_at as string),
  };
};

export const getLoanStateEvents = async (
  loanId: number,
  options: { limit?: number; beforeId?: number } = {},
): Promise<LoanStateEvent[]> => {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 1000);
  const params: unknown[] = [loanId];

  let sql = `
    SELECT id, event_id, loan_id, event_type, payload, actor, occurred_at, created_at
    FROM loan_state_events
    WHERE loan_id = $1
  `;

  if (options.beforeId !== undefined) {
    params.push(options.beforeId);
    sql += ` AND id < $${params.length}`;
  }

  sql += ` ORDER BY occurred_at ASC, id ASC LIMIT $${params.length + 1}`;
  params.push(limit);

  const result = await query(sql, params);
  return (result.rows as Array<Record<string, unknown>>).map((row) => ({
    id: Number(row.id),
    eventId: row.event_id as string,
    loanId: Number(row.loan_id),
    eventType: row.event_type as string,
    payload: (row.payload as Record<string, unknown>) ?? {},
    actor: (row.actor as string | null) ?? null,
    occurredAt: new Date(row.occurred_at as string),
    createdAt: new Date(row.created_at as string),
  }));
};

interface FoldableEvent {
  eventType: string;
  amount?: string | number | undefined;
  occurredAt: Date;
  payload: Record<string, unknown>;
  actor: string | null;
}

const toAmount = (value: unknown): number => {
  if (value === undefined || value === null) return 0;
  const numeric = typeof value === 'number' ? value : Number.parseFloat(String(value));
  return Number.isFinite(numeric) ? numeric : 0;
};

/**
 * Build a current-state snapshot by folding `events` in chronological order.
 * Pure function so it can replay either `loan_state_events` or the raw
 * `contract_events` log (used as a fallback when no domain events exist yet).
 */
export const foldLoanState = (events: FoldableEvent[]): ReplaySnapshot => {
  const state: Omit<
    ReplaySnapshot,
    'loanId' | 'eventCount' | 'firstEventAt' | 'lastEventAt' | 'events'
  > = {
    status: 'unknown',
    principal: 0,
    totalRepaid: 0,
    approved: false,
    defaulted: false,
    disputed: false,
    liquidated: false,
    cancelled: false,
    rejected: false,
  };

  let firstEventAt: Date | null = null;
  let lastEventAt: Date | null = null;

  for (const event of events) {
    const at = event.occurredAt;
    if (!firstEventAt || at < firstEventAt) firstEventAt = at;
    if (!lastEventAt || at > lastEventAt) lastEventAt = at;

    const amount = toAmount(event.payload?.amount ?? event.amount);

    switch (event.eventType) {
      case 'LoanRequested':
        if (amount > 0) state.principal = amount;
        if (state.status === 'unknown') state.status = 'requested';
        break;
      case 'LoanApproved':
        state.approved = true;
        if (!state.cancelled && !state.rejected && !state.liquidated && !state.defaulted) {
          state.status = 'active';
        }
        break;
      case 'LoanRepaid':
        state.totalRepaid += amount;
        break;
      case 'LoanRefinanced':
        if (amount > 0) state.principal = amount;
        if (!state.cancelled && !state.rejected && !state.liquidated && !state.defaulted) {
          state.status = 'active';
        }
        break;
      case 'LoanDefaulted':
        state.defaulted = true;
        state.status = 'defaulted';
        break;
      case 'LoanDisputed':
        state.disputed = true;
        if (!state.cancelled && !state.rejected && !state.liquidated && !state.defaulted) {
          state.status = 'disputed';
        }
        break;
      case 'LoanLiquidated':
      case 'CollateralLiquidated':
        state.liquidated = true;
        state.status = 'liquidated';
        break;
      case 'LoanCancelled':
        state.cancelled = true;
        state.status = 'cancelled';
        break;
      case 'LoanRejected':
        state.rejected = true;
        state.status = 'rejected';
        break;
      default:
        break;
    }
  }

  const loanId = events.length > 0 ? Number((events[0] as { loanId?: number }).loanId ?? 0) : 0;

  return {
    loanId,
    ...state,
    eventCount: events.length,
    firstEventAt: firstEventAt ? firstEventAt.toISOString() : null,
    lastEventAt: lastEventAt ? lastEventAt.toISOString() : null,
    events: events.map((event) => ({
      eventType: event.eventType,
      payload: event.payload,
      actor: event.actor,
      occurredAt: event.occurredAt.toISOString(),
    })),
  };
};

/**
 * Reconstruct the current loan state by replaying its stored domain events.
 *
 * If no rows exist in `loan_state_events` yet (e.g. for loans created before
 * the event log was introduced), it falls back to replaying the raw
 * `contract_events` append-only log so the admin replay endpoint always
 * returns a correct, reconstructable state.
 */
export const replayLoanState = async (loanId: number): Promise<ReplaySnapshot> => {
  const domainEvents = await getLoanStateEvents(loanId, { limit: 1000 });

  if (domainEvents.length > 0) {
    return foldLoanState(
      domainEvents.map((event) => ({
        eventType: event.eventType,
        payload: event.payload,
        actor: event.actor,
        occurredAt: event.occurredAt,
        loanId: event.loanId,
      })),
    );
  }

  try {
    const result = await query(
      `SELECT event_type, amount, ledger_closed_at, tx_hash
         FROM contract_events
         WHERE loan_id = $1
         ORDER BY ledger_closed_at ASC, ledger ASC, id ASC`,
      [loanId],
    );

    const contractEvents: FoldableEvent[] = (result.rows as Array<Record<string, unknown>>).map(
      (row) => ({
        eventType: row.event_type as string,
        amount: row.amount as string | undefined,
        payload: { amount: row.amount ?? null, txHash: row.tx_hash ?? null },
        actor: null,
        occurredAt: new Date(row.ledger_closed_at as string),
        loanId,
      }),
    );

    return foldLoanState(contractEvents);
  } catch (error) {
    logger
      .withContext()
      .warn('Failed to replay loan state from contract_events', { loanId, error });
    return foldLoanState([]);
  }
};
