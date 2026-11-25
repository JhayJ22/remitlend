/**
 * Threat-Model Refresh Gate Service tests (issue #856)
 *
 * Covers:
 *  - success path: initiate review, approve (second-admin), gate passes
 *  - boundary: classifyChangedFiles pattern matching, hashDocument
 *  - access-control: self-approval blocked; boundary validation
 *  - idempotency: duplicate draft rejected; recordBoundaryChange upsert
 *  - gate check: gated when no review, passed when review exists
 *  - dependency-failure: audit_logs failure non-blocking
 *  - generateChangeInventory: multi-boundary, all-pass, partial-fail
 */

import { jest } from '@jest/globals';

jest.setTimeout(30_000);

// ── Mock db/connection ────────────────────────────────────────────────────────

const mockQuery = jest.fn<
  (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>
>();

jest.unstable_mockModule('../../db/connection.js', () => {
  const pool = { query: mockQuery, connect: jest.fn(), on: jest.fn() };
  return { default: pool, pool, query: mockQuery };
});

// ── Load after mock ───────────────────────────────────────────────────────────

let svc: typeof import('../threatModelRefreshService.js');

beforeAll(async () => {
  svc = await import('../threatModelRefreshService.js');
});

afterEach(() => jest.clearAllMocks());

// ── classifyChangedFiles ──────────────────────────────────────────────────────

describe('classifyChangedFiles', () => {
  it('classifies wallet-touching files', () => {
    const r = svc.threatModelRefreshService.classifyChangedFiles([
      'backend/src/services/authService.ts',
    ]);
    expect(r).toContain('wallet');
  });

  it('classifies contract-touching files', () => {
    const r = svc.threatModelRefreshService.classifyChangedFiles([
      'contracts/lending_pool/src/lib.rs',
    ]);
    expect(r).toContain('contract');
  });

  it('classifies api-touching files', () => {
    const r = svc.threatModelRefreshService.classifyChangedFiles([
      'backend/src/routes/adminRoutes.ts',
    ]);
    expect(r).toContain('api');
  });

  it('classifies infra-touching files', () => {
    const r = svc.threatModelRefreshService.classifyChangedFiles([
      'backend/migrations/1234_new-table.js',
    ]);
    expect(r).toContain('infra');
  });

  it('classifies provider-touching files', () => {
    const r = svc.threatModelRefreshService.classifyChangedFiles([
      'backend/src/services/sorobanService.ts',
    ]);
    expect(r).toContain('provider');
  });

  it('returns multiple boundaries for multi-boundary changes', () => {
    const r = svc.threatModelRefreshService.classifyChangedFiles([
      'backend/src/services/authService.ts',      // wallet
      'backend/migrations/1234.js',               // infra
      'contracts/lending_pool/src/lib.rs',         // contract
    ]);
    expect(r).toContain('wallet');
    expect(r).toContain('infra');
    expect(r).toContain('contract');
  });

  it('returns empty array for unrecognised files', () => {
    const r = svc.threatModelRefreshService.classifyChangedFiles([
      'README.md',
      'docs/CHANGELOG.md',
    ]);
    expect(r).toHaveLength(0);
  });
});

// ── hashDocument ──────────────────────────────────────────────────────────────

describe('hashDocument', () => {
  it('produces a 64-char hex string', () => {
    const h = svc.threatModelRefreshService.hashDocument('some threat model content');
    expect(h).toHaveLength(64);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic', () => {
    expect(svc.threatModelRefreshService.hashDocument('x')).toBe(
      svc.threatModelRefreshService.hashDocument('x'),
    );
  });

  it('changes for different content (tamper detection)', () => {
    expect(svc.threatModelRefreshService.hashDocument('v1')).not.toBe(
      svc.threatModelRefreshService.hashDocument('v2'),
    );
  });
});

// ── initiateReview ────────────────────────────────────────────────────────────

describe('initiateReview', () => {
  const makeReview = () => ({
    id: 'review-1',
    boundary: 'api',
    reviewed_by: 'GADMIN1',
    approved_by: null,
    approval_ref: null,
    mitigations: [],
    document_hash: 'a'.repeat(64),
    status: 'draft',
    initiated_at: new Date(),
    approved_at: null,
    next_review_due: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
  });

  it('creates a draft review and writes audit_log', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })          // no existing draft
      .mockResolvedValueOnce({ rows: [makeReview()], rowCount: 1 }) // INSERT
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });           // audit_logs

    const result = await svc.threatModelRefreshService.initiateReview({
      boundary: 'api',
      reviewedBy: 'GADMIN1',
      documentHash: 'a'.repeat(64),
    });

    expect(result.id).toBe('review-1');
    expect(result.status).toBe('draft');
    const insertCall = mockQuery.mock.calls[1] as [string, unknown[]];
    expect(insertCall[0]).toMatch(/INSERT INTO threat_model_reviews/);
  });

  it('rejects duplicate draft for same boundary + reviewer (idempotency)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'existing' }], rowCount: 1 });
    await expect(
      svc.threatModelRefreshService.initiateReview({
        boundary: 'api',
        reviewedBy: 'GADMIN1',
        documentHash: 'a'.repeat(64),
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('rejects unknown boundary', async () => {
    await expect(
      svc.threatModelRefreshService.initiateReview({
        boundary: 'unknown' as svc.TrustBoundary,
        reviewedBy: 'GADMIN1',
        documentHash: 'a'.repeat(64),
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('audit_logs failure is non-blocking', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [makeReview()], rowCount: 1 })
      .mockRejectedValueOnce(new Error('audit DB down'));

    const result = await svc.threatModelRefreshService.initiateReview({
      boundary: 'api',
      reviewedBy: 'GADMIN1',
      documentHash: 'a'.repeat(64),
    });
    expect(result.id).toBe('review-1');
  });
});

// ── approveReview ─────────────────────────────────────────────────────────────

describe('approveReview', () => {
  const draftRow = {
    id: 'review-1', boundary: 'api', reviewed_by: 'GADMIN1',
    status: 'draft', document_hash: 'a'.repeat(64),
  };

  it('approves a draft and supersedes older reviews', async () => {
    const approvedRow = { ...draftRow, status: 'approved', approved_by: 'GADMIN2', approved_at: new Date() };
    mockQuery
      .mockResolvedValueOnce({ rows: [draftRow], rowCount: 1 })    // load draft
      .mockResolvedValueOnce({ rows: [approvedRow], rowCount: 1 }) // UPDATE to approved
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })             // supersede old
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });            // audit_logs

    const result = await svc.threatModelRefreshService.approveReview({
      reviewId: 'review-1',
      approvedBy: 'GADMIN2',
    });
    expect(result.status).toBe('approved');
    expect(result.approved_by).toBe('GADMIN2');

    const supersededCall = mockQuery.mock.calls[2] as [string, unknown[]];
    expect(supersededCall[0]).toMatch(/SET status = 'superseded'/);
  });

  it('blocks self-approval (access-control)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [draftRow], rowCount: 1 });
    await expect(
      svc.threatModelRefreshService.approveReview({
        reviewId: 'review-1',
        approvedBy: 'GADMIN1', // same as reviewed_by
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('throws 404 for missing review', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(
      svc.threatModelRefreshService.approveReview({ reviewId: 'missing', approvedBy: 'GADMIN2' }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('throws 409 for already-approved review', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ ...draftRow, status: 'approved' }],
      rowCount: 1,
    });
    await expect(
      svc.threatModelRefreshService.approveReview({ reviewId: 'review-1', approvedBy: 'GADMIN2' }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

// ── getCurrentReview / checkGate ──────────────────────────────────────────────

describe('getCurrentReview', () => {
  it('returns approved review when one exists', async () => {
    const row = { id: 'rev-1', boundary: 'api', status: 'approved', approved_at: new Date() };
    mockQuery.mockResolvedValueOnce({ rows: [row], rowCount: 1 });
    const r = await svc.threatModelRefreshService.getCurrentReview('api');
    expect(r?.id).toBe('rev-1');
  });

  it('returns null when no current review exists', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const r = await svc.threatModelRefreshService.getCurrentReview('api');
    expect(r).toBeNull();
  });
});

describe('checkGate', () => {
  it('passes when all boundaries have current reviews', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'r1', approved_at: new Date() }], rowCount: 1 }) // api
      .mockResolvedValueOnce({ rows: [{ id: 'r2', approved_at: new Date() }], rowCount: 1 }); // wallet

    const results = await svc.threatModelRefreshService.checkGate(['api', 'wallet']);
    expect(results.every((r) => r.passed)).toBe(true);
  });

  it('fails when a boundary has no current review', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // api — no review
      .mockResolvedValueOnce({ rows: [{ id: 'r2', approved_at: new Date() }], rowCount: 1 }); // wallet — has review

    const results = await svc.threatModelRefreshService.checkGate(['api', 'wallet']);
    const api = results.find((r) => r.boundary === 'api');
    const wallet = results.find((r) => r.boundary === 'wallet');
    expect(api?.passed).toBe(false);
    expect(wallet?.passed).toBe(true);
  });
});

// ── recordBoundaryChange ──────────────────────────────────────────────────────

describe('recordBoundaryChange', () => {
  it('records as passed when a current review exists', async () => {
    const reviewRow = { id: 'rev-1', approved_at: new Date() };
    const changeRow = {
      id: 'chg-1', boundary: 'api', change_ref: 'pr-123',
      gate_status: 'passed', review_id: 'rev-1', recorded_at: new Date(),
    };
    mockQuery
      .mockResolvedValueOnce({ rows: [reviewRow], rowCount: 1 }) // getCurrentReview
      .mockResolvedValueOnce({ rows: [changeRow], rowCount: 1 }); // INSERT

    const r = await svc.threatModelRefreshService.recordBoundaryChange({
      boundary: 'api',
      changeRef: 'pr-123',
      description: 'Added new admin route',
      changedFiles: ['backend/src/routes/adminRoutes.ts'],
    });
    expect(r.gate_status).toBe('passed');
  });

  it('records as gated when no current review exists', async () => {
    const changeRow = {
      id: 'chg-2', boundary: 'api', change_ref: 'pr-456',
      gate_status: 'gated', review_id: null, recorded_at: new Date(),
    };
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // no current review
      .mockResolvedValueOnce({ rows: [changeRow], rowCount: 1 }); // INSERT

    const r = await svc.threatModelRefreshService.recordBoundaryChange({
      boundary: 'api',
      changeRef: 'pr-456',
      description: 'Changed auth middleware',
      changedFiles: ['backend/src/routes/adminRoutes.ts'],
    });
    expect(r.gate_status).toBe('gated');
  });

  it('records as forced when force=true', async () => {
    const changeRow = {
      id: 'chg-3', boundary: 'contract', change_ref: 'pr-789',
      gate_status: 'forced', forced_by: 'GADMIN', recorded_at: new Date(),
    };
    mockQuery
      .mockResolvedValueOnce({ rows: [changeRow], rowCount: 1 }) // INSERT
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });           // audit_logs for force

    const r = await svc.threatModelRefreshService.recordBoundaryChange({
      boundary: 'contract',
      changeRef: 'pr-789',
      description: 'Emergency hotfix',
      changedFiles: ['contracts/src/lib.rs'],
      force: true,
      forcedBy: 'GADMIN',
      forceReason: 'Emergency fix for CVE-XYZ',
    });
    expect(r.gate_status).toBe('forced');
  });

  it('throws when force=true but forceReason missing', async () => {
    await expect(
      svc.threatModelRefreshService.recordBoundaryChange({
        boundary: 'contract',
        changeRef: 'pr-000',
        description: 'oops',
        changedFiles: ['contracts/src/lib.rs'],
        force: true,
        forcedBy: 'GADMIN',
        // force_reason missing
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

// ── generateChangeInventory ───────────────────────────────────────────────────

describe('generateChangeInventory', () => {
  it('returns allPassed=true when all boundaries have current reviews', async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: 'r1', approved_at: new Date() }], rowCount: 1 });

    const result = await svc.threatModelRefreshService.generateChangeInventory({
      files: ['backend/src/routes/adminRoutes.ts'],
      changeRef: 'pr-1',
    });
    expect(result.allPassed).toBe(true);
    expect(result.touchedBoundaries).toContain('api');
  });

  it('returns allPassed=false when any boundary is missing a review', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 }); // no reviews

    const result = await svc.threatModelRefreshService.generateChangeInventory({
      files: ['contracts/lending_pool/src/lib.rs'],
      changeRef: 'pr-2',
    });
    expect(result.allPassed).toBe(false);
    expect(result.touchedBoundaries).toContain('contract');
  });

  it('returns empty with allPassed=true for files touching no boundaries', async () => {
    const result = await svc.threatModelRefreshService.generateChangeInventory({
      files: ['README.md', 'LICENSE'],
      changeRef: 'pr-3',
    });
    expect(result.touchedBoundaries).toHaveLength(0);
    expect(result.allPassed).toBe(true);
  });
});

// ── listReviews / listChanges / getReview ─────────────────────────────────────

describe('listReviews', () => {
  it('returns paginated results', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ id: `r${i}`, boundary: 'api', status: 'approved' }));
    mockQuery.mockResolvedValueOnce({ rows, rowCount: 3 });
    const r = await svc.threatModelRefreshService.listReviews({});
    expect(r.data).toHaveLength(3);
    expect(r.nextCursor).toBeNull();
  });

  it('sets nextCursor when more results exist', async () => {
    const rows = Array.from({ length: 4 }, (_, i) => ({ id: `r${i}`, boundary: 'api' }));
    mockQuery.mockResolvedValueOnce({ rows, rowCount: 4 });
    const r = await svc.threatModelRefreshService.listReviews({ limit: 3 });
    expect(r.data).toHaveLength(3);
    expect(r.nextCursor).toBe('r2');
  });
});

describe('getReview', () => {
  it('returns the row', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'r1', status: 'draft' }], rowCount: 1 });
    const r = await svc.threatModelRefreshService.getReview('r1');
    expect(r.id).toBe('r1');
  });
  it('throws 404 for missing review', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(svc.threatModelRefreshService.getReview('missing')).rejects.toMatchObject({ statusCode: 404 });
  });
});
