import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { query } from '../db/connection.js';
import { AppError } from '../errors/AppError.js';
import { eventStreamService } from '../services/eventStreamService.js';
import logger from '../utils/logger.js';

const REPLAY_LIMIT = 100;

type DbEventRow = Record<string, unknown>;

const mapLoanEventRow = (row: DbEventRow) => ({
  eventId: String(row.event_id ?? ''),
  eventType: String(row.event_type ?? ''),
  loanId: row.loan_id !== undefined ? Number(row.loan_id) : undefined,
  address: String(row.address ?? row.borrower ?? ''),
  amount: row.amount !== undefined ? String(row.amount) : undefined,
  ledger: Number(row.ledger ?? 0),
  ledgerClosedAt: String(row.ledger_closed_at ?? ''),
  txHash: String(row.tx_hash ?? ''),
});

const parseLastEventId = (req: Request): string | null => {
  const headerValue = req.headers['last-event-id'];
  if (typeof headerValue === 'string' && headerValue.trim().length > 0) {
    return headerValue.trim();
  }

  if (Array.isArray(headerValue) && headerValue[0]?.trim()) {
    return headerValue[0].trim();
  }

  return null;
};

/**
 * Parse the `topics` query parameter into a normalized list of topic names.
 * Accepts a comma-separated string (e.g. `topics=loan_updated,pool_updated`)
 * or a repeated query parameter. Returns `undefined` when no topics are
 * requested, meaning the client wants every event.
 */
const parseTopics = (req: Request): string[] | undefined => {
  const raw = req.query.topics;
  const values: string[] = [];

  if (typeof raw === 'string') {
    values.push(...raw.split(','));
  } else if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry === 'string') {
        values.push(...entry.split(','));
      }
    }
  }

  const topics = values.map((topic) => topic.trim()).filter((topic) => topic.length > 0);
  return topics.length > 0 ? Array.from(new Set(topics)) : undefined;
};

/**
 * GET /api/events/stream?borrower=G...&topics=loan_updated,pool_updated
 *
 * SSE endpoint for real-time loan events.
 * - With `?borrower=G...` — streams events for that specific borrower (requires JWT matching)
 * - Without `?borrower` — streams all events (requires API key for admin access)
 * - With `?topics=a,b` — only events matching the listed topics are dispatched
 */
export const streamEvents = asyncHandler(async (req: Request, res: Response) => {
  const requestedBorrower = typeof req.query.borrower === 'string' ? req.query.borrower : undefined;
  const topics = parseTopics(req);
  const lastEventId = parseLastEventId(req);
  const userKey = req.user?.publicKey;
  const role = req.user?.role;

  if (!userKey) {
    throw AppError.unauthorized('Authentication required');
  }

  const isAdmin = role === 'admin';

  if (!isAdmin && requestedBorrower && requestedBorrower !== userKey) {
    throw AppError.forbidden('Borrowers can only subscribe to their own events');
  }

  const borrower = requestedBorrower ?? (isAdmin ? undefined : userKey);

  if (!eventStreamService.canOpenConnection(userKey)) {
    throw new AppError(
      `Maximum of ${eventStreamService.getMaxConnectionsPerUser()} SSE connections allowed per user`,
      429,
    );
  }

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let unsubscribe: () => void;

  if (borrower) {
    // Send replay events first (if Last-Event-ID is provided), otherwise
    // send recent events for initial context.
    try {
      const replayEvents = await query(
        `SELECT event_id, event_type, loan_id, address, amount, ledger, ledger_closed_at, tx_hash
           FROM contract_events
           WHERE address = $1
             AND (
               $2::text IS NULL
               OR id > COALESCE((SELECT id FROM contract_events WHERE event_id = $2), 0)
             )
           ORDER BY id ASC
           LIMIT $3`,
        [borrower, lastEventId, REPLAY_LIMIT],
      );

      if (replayEvents.rows.length > 0) {
        for (const row of replayEvents.rows) {
          const event = mapLoanEventRow(row as DbEventRow);
          if (topics && !topics.includes(event.eventType)) {
            continue;
          }
          eventStreamService.sendEvent(res, event);
        }
      } else if (!lastEventId) {
        res.write(`event: init\ndata: ${JSON.stringify({ type: 'init', replayed: 0, topics: topics ?? null })}\n\n`);
      }
    } catch (err) {
      logger.withContext().error('SSE replay fetch error', { borrower, lastEventId, err });
    }

    unsubscribe = eventStreamService.subscribeAddress(userKey, borrower, res, topics);
  } else {
    try {
      const replayEvents = await query(
        `SELECT event_id, event_type, loan_id, address, amount, ledger, ledger_closed_at, tx_hash
           FROM contract_events
           WHERE (
             $1::text IS NULL
             OR id > COALESCE((SELECT id FROM contract_events WHERE event_id = $1), 0)
           )
           ORDER BY id ASC
           LIMIT $2`,
        [lastEventId, REPLAY_LIMIT],
      );

      if (replayEvents.rows.length > 0) {
        for (const row of replayEvents.rows) {
          const event = mapLoanEventRow(row as DbEventRow);
          if (topics && !topics.includes(event.eventType)) {
            continue;
          }
          eventStreamService.sendEvent(res, event);
        }
      }
    } catch (err) {
      logger.withContext().error('SSE admin replay fetch error', { lastEventId, err });
    }

    const counts = eventStreamService.getConnectionCount();
    res.write(`event: init\ndata: ${JSON.stringify({ type: 'init', connections: counts, topics: topics ?? null })}\n\n`);
    unsubscribe = eventStreamService.subscribeAll(userKey, res, topics);
  }

  req.on('close', unsubscribe);
  req.on('error', unsubscribe);
});

/**
 * GET /api/events/status
 *
 * Returns the current SSE connection counts (admin use).
 */
export const getEventStreamStatus = asyncHandler(async (_req: Request, res: Response) => {
  const counts = eventStreamService.getConnectionCount();
  res.json({ success: true, data: counts });
});
