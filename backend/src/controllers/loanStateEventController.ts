import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../errors/AppError.js';
import { ErrorCode } from '../errors/errorCodes.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getLoanStateEvents, replayLoanState } from '../services/loanStateEventStore.js';

/**
 * GET /api/admin/loans/:loanId/replay-state
 *
 * Admin-only endpoint (issue #75) that reconstructs a loan's current state by
 * replaying its append-only event log. Returns the folded snapshot plus the
 * full ordered event list so the result is fully auditable.
 */
export const replayLoanStateEndpoint = asyncHandler(
  async (req: Request, res: Response, _next: NextFunction) => {
    const loanId = Number.parseInt(req.params.loanId as string, 10);
    if (!Number.isFinite(loanId) || loanId <= 0) {
      throw AppError.badRequest('Invalid loan ID', ErrorCode.INVALID_LOAN_ID, 'loanId');
    }

    const snapshot = await replayLoanState(loanId);

    res.json({
      success: true,
      loanId,
      state: {
        status: snapshot.status,
        principal: snapshot.principal,
        totalRepaid: snapshot.totalRepaid,
        approved: snapshot.approved,
        defaulted: snapshot.defaulted,
        disputed: snapshot.disputed,
        liquidated: snapshot.liquidated,
        cancelled: snapshot.cancelled,
        rejected: snapshot.rejected,
        eventCount: snapshot.eventCount,
        firstEventAt: snapshot.firstEventAt,
        lastEventAt: snapshot.lastEventAt,
      },
      events: snapshot.events,
    });
  },
);

/**
 * GET /api/admin/loans/:loanId/state-events
 *
 * Returns the raw, append-only loan state events for a loan in chronological
 * order (newest last), supporting cursor pagination via `beforeId`.
 */
export const listLoanStateEventsEndpoint = asyncHandler(
  async (req: Request, res: Response, _next: NextFunction) => {
    const loanId = Number.parseInt(req.params.loanId as string, 10);
    if (!Number.isFinite(loanId) || loanId <= 0) {
      throw AppError.badRequest('Invalid loan ID', ErrorCode.INVALID_LOAN_ID, 'loanId');
    }

    const limit = Number.parseInt((req.query.limit as string) ?? '100', 10);
    const beforeId = req.query.beforeId
      ? Number.parseInt(req.query.beforeId as string, 10)
      : undefined;

    const options: { limit: number; beforeId?: number } = {
      limit: Number.isFinite(limit) ? limit : 100,
    };
    if (beforeId !== undefined && Number.isFinite(beforeId)) {
      options.beforeId = beforeId;
    }

    const events = await getLoanStateEvents(loanId, options);

    res.json({
      success: true,
      loanId,
      events: events.map((event) => ({
        eventId: event.eventId,
        eventType: event.eventType,
        payload: event.payload,
        actor: event.actor,
        occurredAt: event.occurredAt.toISOString(),
        createdAt: event.createdAt.toISOString(),
      })),
    });
  },
);
