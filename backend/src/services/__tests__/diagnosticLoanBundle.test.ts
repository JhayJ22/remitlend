import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../auditLogService.js', () => ({
  auditLogService: { log: jest.fn(async () => undefined) },
}));

const {
  DiagnosticBundleService,
  signBundle,
  verifyBundleSignature,
  LOAN_BUNDLE_TTL_MS,
} = await import('../diagnosticBundleService.js');

process.env.JWT_SECRET = 'test-secret-test-secret';

function makePool(overrides: Record<string, unknown[]> = {}) {
  const query = jest.fn(async (sql: string) => {
    const s = sql.replace(/\s+/g, ' ');
    if (s.includes('FROM loan_history'))
      return { rows: overrides.loan ?? [{ loan_id: 7, borrower_public_key: 'GB1' }] };
    if (s.includes('FROM loan_events')) return { rows: [{ id: 1, event_type: 'LoanApproved' }] };
    if (s.includes('FROM transaction_submissions') && s.includes('envelope_xdr'))
      return { rows: overrides.tx ?? [] };
    if (s.includes('FROM transaction_submissions')) return { rows: [{ id: 3, tx_hash: 'abc' }] };
    if (s.includes('FROM notifications')) return { rows: [{ id: 9 }] };
    if (s.includes('FROM audit_logs')) return { rows: [{ id: 2, action: 'x' }] };
    if (s.includes('FROM scores')) return { rows: [{ borrower: 'GB1', score: 640 }] };
    if (s.includes('INSERT INTO diagnostic_bundles')) return { rows: [{ id: 42 }] };
    if (s.includes('DELETE FROM diagnostic_bundles')) return { rows: [], rowCount: 2 };
    return { rows: [] };
  });
  return { query };
}

describe('collectLoanBundle', () => {
  beforeEach(() => jest.clearAllMocks());

  it('includes all entities, a 7-day TTL and a verifiable HMAC', async () => {
    const pool = makePool();
    const svc = new DiagnosticBundleService(pool as never);
    const { bundle, signature } = await svc.collectLoanBundle(7, 'GADMIN');

    expect(bundle.bundleId).toBe('42');
    expect(bundle.loan).toMatchObject({ loan_id: 7 });
    expect(bundle.events).toHaveLength(1);
    expect(bundle.transactions).toHaveLength(1);
    expect(bundle.notifications).toHaveLength(1);
    expect(bundle.auditLogs).toHaveLength(1);
    expect(bundle.scoreHistory).toHaveLength(1);
    expect(Date.parse(bundle.expiresAt) - Date.parse(bundle.createdAt)).toBe(LOAN_BUNDLE_TTL_MS);

    expect(verifyBundleSignature(bundle, signature)).toBe(true);
    expect(verifyBundleSignature({ ...bundle, loanId: 8 }, signature)).toBe(false);
    expect(signature).toBe(signBundle(bundle));
  });

  it('404s for an unknown loan', async () => {
    const svc = new DiagnosticBundleService(makePool({ loan: [] }) as never);
    await expect(svc.collectLoanBundle(99, 'GADMIN')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('getReplayData', () => {
  it('returns the raw XDR and submission params', async () => {
    const pool = makePool({
      tx: [
        {
          id: 3,
          tx_hash: 'abc',
          status: 'pending',
          transaction_type: 'loan',
          envelope_xdr: 'AAAAAgAAAAA=',
          submitted_at: new Date('2026-01-01T00:00:00Z'),
          submitted_by: 'GB1',
        },
      ],
    });
    const replay = await new DiagnosticBundleService(pool as never).getReplayData('3');
    expect(replay.envelopeXdr).toBe('AAAAAgAAAAA=');
    expect(replay.submissionParams.submittedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('404s when no XDR was recorded', async () => {
    const pool = makePool({ tx: [{ id: 3, tx_hash: 'abc', envelope_xdr: null }] });
    await expect(new DiagnosticBundleService(pool as never).getReplayData('3')).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describe('cleanupExpiredBundles', () => {
  it('deletes expired rows using the supplied clock', async () => {
    const pool = makePool();
    const now = new Date('2026-02-01T00:00:00Z');
    const n = await new DiagnosticBundleService(pool as never).cleanupExpiredBundles(now);
    expect(n).toBe(2);
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('expires_at <= $1'), [now]);
  });
});
