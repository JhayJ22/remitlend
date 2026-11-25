import {
  DISPUTE_TRANSITIONS,
  assertDisputeTransition,
  type DisputeStatus,
} from '../services/disputeStateMachine.js';

const STATES = Object.keys(DISPUTE_TRANSITIONS) as DisputeStatus[];
const LEGAL: Array<[DisputeStatus, DisputeStatus]> = [
  ['open', 'under_review'],
  ['under_review', 'resolved'],
  ['under_review', 'dismissed'],
];

describe('loan dispute state machine', () => {
  it.each(LEGAL)('allows %s -> %s', (from, to) => {
    expect(() => assertDisputeTransition(from, to)).not.toThrow();
  });

  const illegal = STATES.flatMap((from) =>
    STATES.filter((to) => !LEGAL.some(([f, t]) => f === from && t === to)).map(
      (to) => [from, to] as [DisputeStatus, DisputeStatus],
    ),
  );

  it.each(illegal)('rejects %s -> %s with 400', (from, to) => {
    expect(() => assertDisputeTransition(from, to)).toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
  });

  it('rejects unknown source states', () => {
    expect(() => assertDisputeTransition('bogus', 'resolved')).toThrow();
  });

  it('treats resolved and dismissed as terminal', () => {
    expect(DISPUTE_TRANSITIONS.resolved).toEqual([]);
    expect(DISPUTE_TRANSITIONS.dismissed).toEqual([]);
  });
});
