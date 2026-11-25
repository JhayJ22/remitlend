import { query } from '../db/connection.js';
import { AppError } from '../errors/AppError.js';

export type DisputeStatus = 'open' | 'under_review' | 'resolved' | 'dismissed';

/** Open → UnderReview → Resolved | Dismissed. Nothing else is permitted. */
export const DISPUTE_TRANSITIONS: Record<DisputeStatus, readonly DisputeStatus[]> = {
  open: ['under_review'],
  under_review: ['resolved', 'dismissed'],
  resolved: [],
  dismissed: [],
};

export function assertDisputeTransition(from: string, to: DisputeStatus): void {
  const allowed = DISPUTE_TRANSITIONS[from as DisputeStatus];
  if (!allowed || !allowed.includes(to)) {
    throw AppError.badRequest(`Illegal dispute transition: ${from} -> ${to}`);
  }
}

export interface DisputeAuditEntry {
  actor: string;
  disputeId: number | string;
  from: string;
  to: DisputeStatus;
  note?: string | null | undefined;
}

/** Record a dispute state transition in audit_logs. */
export async function recordDisputeTransition(e: DisputeAuditEntry): Promise<void> {
  await query(
    `INSERT INTO audit_logs (actor, action, target, payload, status)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      e.actor,
      'dispute.transition',
      `loan_dispute:${e.disputeId}`,
      JSON.stringify({ previousState: e.from, newState: e.to, note: e.note ?? null }),
      200,
    ],
  );
}
