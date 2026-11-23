/**
 * Erasure Service tests (issue #847)
 *
 * Covers:
 *  - success path: initiate, execute, certificate issuance, hash verification
 *  - boundary: computeCertificateHash determinism + tamper detection
 *  - idempotency: duplicate initiation rejected; completed re-execution rejected
 *  - access-control: active loan blocks erasure initiation
 *  - dependency-failure: audit_logs failure non-blocking; kek_revocations skip
 *  - certificate verification: hash_verified true/false
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

// ── Load module after mock ────────────────────────────────────────────────────

let svc: typeof import('../erasureService.js');
let computeHash: typeof import('../erasureService.js').computeCertificateHash;

beforeAll(async () => {
  svc = await import('../erasureService.js');
  computeHash = svc.computeCertificateHash;
});

afterEach(() => jest.clearAllMocks());

// ── computeCertificateHash ────────────────────────────────────────────────────

describe('computeCertificateHash', () => {
  const basePayload = {
    erasure_request_id: 'req-1',
    user_public_key: 'GPUBKEY',
    fields_erased: [{ table: 'user_profiles', field: 'email', record_count: 1 }],
    fields_retained: [],
    storage_tiers: { primary: '2026-01-01T00:00:00.000Z', replicas: null, backups: null, exports: null },
    issued_at: '2026-01-01T00:00:00.000Z',
    issued_by: 'GADMIN',
  };

  it('produces a 64-char hex string', () => {
    const h = computeHash(basePayload);
    expect(h).toHaveLength(64);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic — same input yields same hash', () => {
    expect(computeHash(basePayload)).toBe(computeHash(basePayload));
  });

  it('changes when any field is modified (tamper detection)', () => {
    const tampered = { ...basePayload, issued_by: 'GEVIL' };
    expect(computeHash(tampered)).not.toBe(computeHash(basePayload));
  });

  it('changes when fields_erased changes', () => {
    const tampered = { ...basePayload, fields_erased: [] };
    expect(computeHash(tampered)).not.toBe(computeHash(basePayload));
  });
});

// ── initiateErasure ───────────────────────────────────────────────────────────

describe('initiateErasure', () => {
  const makeRequestRow = () => ({
    id: 'req-uuid-1',
    user_public_key: 'GPUBKEY',
    requested_by: 'GPUBKEY',
    reason: 'right_to_erasure',
    consent_ref: null,
    status: 'pending',
    storage_tiers_completed: { primary: false, replicas: false, backups: false, exports: false },
    retention_exceptions: [],
    certificate_id: null,
    initiated_at: new Date(),
    completed_at: null,
    failed_at: null,
    failure_reason: null,
    notified_at: null,
  });

  it('creates a pending request and writes audit_log', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })          // no existing request
      .mockResolvedValueOnce({ rows: [{ cnt: '0' }], rowCount: 1 }) // no active loans
      .mockResolvedValueOnce({ rows: [makeRequestRow()], rowCount: 1 }) // INSERT
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });           // audit_logs

    const result = await svc.erasureService.initiateErasure({
      userPublicKey: 'GPUBKEY',
      requestedBy: 'GPUBKEY',
      reason: 'right_to_erasure',
    });

    expect(result.id).toBe('req-uuid-1');
    expect(result.status).toBe('pending');

    // Verify INSERT called
    const insertCall = mockQuery.mock.calls[2] as [string, unknown[]];
    expect(insertCall[0]).toMatch(/INSERT INTO erasure_requests/);
    expect(insertCall[1]).toContain('GPUBKEY');
  });

  it('rejects if a pending request already exists (idempotency)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'existing', status: 'pending' }],
      rowCount: 1,
    });

    await expect(
      svc.erasureService.initiateErasure({
        userPublicKey: 'GPUBKEY',
        requestedBy: 'GPUBKEY',
        reason: 'right_to_erasure',
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('rejects if the user has an active financial obligation', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })              // no existing
      .mockResolvedValueOnce({ rows: [{ cnt: '1' }], rowCount: 1 }); // active loan

    await expect(
      svc.erasureService.initiateErasure({
        userPublicKey: 'GPUBKEY',
        requestedBy: 'GPUBKEY',
        reason: 'account_closure',
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('audit_logs failure is non-blocking — request still returned', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ cnt: '0' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [makeRequestRow()], rowCount: 1 })
      .mockRejectedValueOnce(new Error('audit_logs DB down')); // audit write fails

    const result = await svc.erasureService.initiateErasure({
      userPublicKey: 'GPUBKEY',
      requestedBy: 'GPUBKEY',
      reason: 'right_to_erasure',
    });
    expect(result.id).toBe('req-uuid-1');
  });
});

// ── executeErasure ────────────────────────────────────────────────────────────

describe('executeErasure', () => {
  const reqRow = {
    id: 'req-1', user_public_key: 'GPUBKEY', status: 'in_progress',
    initiated_at: new Date(),
  };

  const certRow = {
    id: 'cert-1', erasure_request_id: 'req-1',
    certificate_hash: 'a'.repeat(64),
    fields_erased: [{ table: 'user_profiles', field: 'email', record_count: 1 }],
    fields_retained: [],
    retention_basis: 'AML',
    kek_revocation_ref: 'user:GPUBKEY',
    storage_tiers: { primary: new Date().toISOString(), replicas: null, backups: null, exports: null },
    issued_at: new Date(),
    issued_by: 'GADMIN',
  };

  it('succeeds: claims request, erases PII, issues certificate', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ ...reqRow, status: 'in_progress' }], rowCount: 1 }) // UPDATE claim
      .mockResolvedValueOnce({ rows: [{ id: 'up-1' }], rowCount: 1 })  // UPDATE user_profiles
      .mockResolvedValueOnce({ rows: [], rowCount: 3 })                 // DELETE notifications
      .mockResolvedValueOnce({ rows: [], rowCount: 2 })                 // UPDATE pii_encrypted_fields
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                 // INSERT kek_revocations
      .mockResolvedValueOnce({ rows: [{ cnt: '5' }], rowCount: 1 })    // audit_logs count
      .mockResolvedValueOnce({ rows: [{ cnt: '2' }], rowCount: 1 })    // pii_access_log count
      .mockResolvedValueOnce({ rows: [{ cnt: '0' }], rowCount: 1 })    // loan_events count
      .mockResolvedValueOnce({ rows: [certRow], rowCount: 1 })          // INSERT certificate
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                 // UPDATE request completed
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });                // audit_log

    const cert = await svc.erasureService.executeErasure({
      requestId: 'req-1',
      executedBy: 'GADMIN',
    });

    expect(cert.id).toBe('cert-1');
    expect(cert.erasure_request_id).toBe('req-1');

    // Verify certificate was inserted
    const certInsert = mockQuery.mock.calls.find(
      (c) => typeof (c as [string])[0] === 'string' && (c as [string])[0].includes('INSERT INTO erasure_certificates'),
    );
    expect(certInsert).toBeDefined();
  });

  it('rejects with 409 when request is already completed', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // UPDATE claim returns nothing
      .mockResolvedValueOnce({ rows: [{ id: 'req-1', status: 'completed' }], rowCount: 1 }); // SELECT check

    await expect(
      svc.erasureService.executeErasure({ requestId: 'req-1', executedBy: 'GADMIN' }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('rejects with 404 when request does not exist', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // UPDATE claim
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // SELECT check

    await expect(
      svc.erasureService.executeErasure({ requestId: 'missing', executedBy: 'GADMIN' }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('marks request failed when an execution step throws', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ ...reqRow, status: 'in_progress' }], rowCount: 1 }) // claim
      .mockRejectedValueOnce(new Error('DB timeout during PII null'))  // UPDATE user_profiles fails
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });               // UPDATE status = failed

    await expect(
      svc.erasureService.executeErasure({ requestId: 'req-1', executedBy: 'GADMIN' }),
    ).rejects.toThrow('DB timeout during PII null');

    // Verify the failed UPDATE was called
    const failedCall = mockQuery.mock.calls.find(
      (c) => typeof (c as [string])[0] === 'string' && (c as [string])[0].includes("status = 'failed'"),
    );
    expect(failedCall).toBeDefined();
  });

  it('continues when kek_revocations table does not exist (dependency failure)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ ...reqRow, status: 'in_progress' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'up-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockRejectedValueOnce(new Error('relation "kek_revocations" does not exist')) // KEK revoke fails
      .mockResolvedValueOnce({ rows: [{ cnt: '0' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ cnt: '0' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ cnt: '0' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [certRow], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    // Should not throw even though kek_revocations is missing
    const cert = await svc.erasureService.executeErasure({
      requestId: 'req-1',
      executedBy: 'GADMIN',
    });
    expect(cert.id).toBe('cert-1');
  });
});

// ── verifyCertificateHash ─────────────────────────────────────────────────────

describe('verifyCertificateHash', () => {
  it('returns true for an untampered certificate', () => {
    const payload = {
      erasure_request_id: 'req-1',
      user_public_key: 'GPUBKEY',
      fields_erased: [{ table: 'user_profiles', field: 'email', record_count: 1 }],
      fields_retained: [],
      storage_tiers: { primary: '2026-01-01T00:00:00.000Z', replicas: null, backups: null, exports: null },
      issued_at: '2026-01-01T00:00:00.000Z',
      issued_by: 'GADMIN',
    };
    const hash = computeHash(payload);

    const cert = {
      id: 'cert-1',
      erasure_request_id: 'req-1',
      certificate_hash: hash,
      fields_erased: payload.fields_erased,
      fields_retained: [],
      retention_basis: null,
      kek_revocation_ref: null,
      storage_tiers: payload.storage_tiers,
      issued_at: new Date(payload.issued_at),
      issued_by: 'GADMIN',
    } as import('../erasureService.js').ErasureCertificate;

    expect(svc.erasureService.verifyCertificateHash(cert, 'GPUBKEY')).toBe(true);
  });

  it('returns false when the hash does not match (tampered certificate)', () => {
    const cert = {
      id: 'cert-1',
      erasure_request_id: 'req-1',
      certificate_hash: 'deadbeef'.repeat(8), // wrong hash
      fields_erased: [],
      fields_retained: [],
      retention_basis: null,
      kek_revocation_ref: null,
      storage_tiers: { primary: '2026-01-01T00:00:00.000Z', replicas: null, backups: null, exports: null },
      issued_at: new Date('2026-01-01T00:00:00.000Z'),
      issued_by: 'GADMIN',
    } as import('../erasureService.js').ErasureCertificate;

    expect(svc.erasureService.verifyCertificateHash(cert, 'GPUBKEY')).toBe(false);
  });
});

// ── getRequest / getCertificate ───────────────────────────────────────────────

describe('getRequest', () => {
  it('returns the row', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'req-1', status: 'pending' }], rowCount: 1 });
    const r = await svc.erasureService.getRequest('req-1');
    expect(r.id).toBe('req-1');
  });
  it('throws 404 for missing request', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(svc.erasureService.getRequest('missing')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('getCertificate', () => {
  it('returns the certificate', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'cert-1' }], rowCount: 1 });
    const c = await svc.erasureService.getCertificate('req-1');
    expect(c.id).toBe('cert-1');
  });
  it('throws 404 when no certificate exists', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(svc.erasureService.getCertificate('req-1')).rejects.toMatchObject({ statusCode: 404 });
  });
});

// ── listRequests ──────────────────────────────────────────────────────────────

describe('listRequests', () => {
  it('returns paginated results', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ id: `r${i}`, status: 'pending' }));
    mockQuery.mockResolvedValueOnce({ rows, rowCount: 3 });
    const r = await svc.erasureService.listRequests({ limit: 50 });
    expect(r.data).toHaveLength(3);
    expect(r.nextCursor).toBeNull();
  });

  it('sets nextCursor when more results exist', async () => {
    const rows = Array.from({ length: 4 }, (_, i) => ({ id: `r${i}`, status: 'pending' }));
    mockQuery.mockResolvedValueOnce({ rows, rowCount: 4 });
    const r = await svc.erasureService.listRequests({ limit: 3 });
    expect(r.data).toHaveLength(3);
    expect(r.nextCursor).toBe('r2');
  });

  it('filters by status', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await svc.erasureService.listRequests({ status: 'completed' });
    const sql = (mockQuery.mock.calls[0] as [string])[0];
    expect(sql).toContain('status = $');
  });
});
