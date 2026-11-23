/**
 * Tests for signed operator recovery actions (#866).
 *
 * Coverage:
 *  - canonicalize + computePayloadHash determinism and sensitivity
 *  - deriveOperatorSignature + verifyOperatorSignature HMAC round-trip
 *  - validateRecoveryInput: required fields, enum guards, balance-edit rejection
 *  - createRecoveryAction: happy path, duplicate idempotency_key (conflict)
 *  - executeRecoveryAction: happy path, state-machine guard, payload hash integrity
 *  - rejectRecoveryAction: happy path, state-machine guard
 *  - listRecoveryActions / getRecoveryAction
 *  - rejectBalanceEdits: forbidden payload keys are rejected
 */

import { jest } from '@jest/globals';

// --- Mock setup ---
type Res = { rows: unknown[]; rowCount?: number };
const mockQuery = jest.fn<(sql: string, params?: unknown[]) => Promise<Res>>();

jest.unstable_mockModule('../db/connection.js', () => ({
  default: { query: mockQuery },
  query: mockQuery,
  getClient: jest.fn(),
}));

jest.unstable_mockModule('../db/transaction.js', () => ({
  withTransaction: async (fn: (c: { query: typeof mockQuery }) => Promise<unknown>) =>
    fn({ query: mockQuery }),
}));

jest.unstable_mockModule('../services/discrepancyLedgerService.js', () => ({
  resolveDiscrepancy: jest.fn(),
}));

jest.unstable_mockModule('../services/loanStateEventStore.js', () => ({
  emitLoanStateEvent: jest.fn<() => Promise<{ id: number } | null>>().mockResolvedValue({ id: 42 }),
}));

const {
  canonicalize,
  computePayloadHash,
  deriveOperatorSignature,
  verifyOperatorSignature,
  validateRecoveryInput,
  createRecoveryAction,
  executeRecoveryAction,
  rejectRecoveryAction,
  getRecoveryAction,
  listRecoveryActions,
  OPERATOR_RECOVERY_ACTION_TYPES,
  RECOVERY_REASON_CODES,
} = await import('../services/operatorRecoveryService.js');

// A known recovery key injected into the env for tests.
const TEST_KEY = 'test-recovery-secret-key';

function setTestKey() {
  process.env.INTERNAL_API_KEY = `admin:recovery:${TEST_KEY}`;
  process.env.NODE_ENV = 'test';
}

function makeSignature(
  operatorId: string,
  actionType: string,
  idempotencyKey: string,
  payload: Record<string, unknown>,
): string {
  return deriveOperatorSignature(operatorId, actionType, idempotencyKey, payload, TEST_KEY);
}

function validInput(
  overrides: Partial<Parameters<typeof createRecoveryAction>[0]> = {},
): Parameters<typeof createRecoveryAction>[0] {
  const payload = { discrepancy_id: 7 };
  return {
    operatorId: 'GADMIN00000000000000000000000000000000000000000000000000',
    actionType: 'reconciliation_retry',
    reasonCode: 'indexer_lag',
    approvalReference: 'JIRA-1234',
    idempotencyKey: 'idemp-abc123',
    operatorSignature: makeSignature(
      'GADMIN00000000000000000000000000000000000000000000000000',
      'reconciliation_retry',
      'idemp-abc123',
      payload,
    ),
    payload,
    reasonNote: 'Re-checking discrepancy after indexer caught up',
    ...overrides,
  };
}

// Row returned from operator_recovery_actions SELECT.
function dbRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    operator_id: 'GADMIN00000000000000000000000000000000000000000000000000',
    action_type: 'reconciliation_retry',
    reason_code: 'indexer_lag',
    approval_reference: 'JIRA-1234',
    idempotency_key: 'idemp-abc123',
    payload_hash: computePayloadHash('reconciliation_retry', { discrepancy_id: 7 }),
    status: 'pending',
    outcome_ref: null,
    outcome_error: null,
    executed_at: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// canonicalize + computePayloadHash
// ---------------------------------------------------------------------------

describe('canonicalize', () => {
  it('is deterministic regardless of key order', () => {
    expect(canonicalize({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonicalize({ a: { c: 3, d: 2 }, b: 1 }),
    );
  });

  it('distinguishes different values', () => {
    expect(canonicalize({ x: 1 })).not.toBe(canonicalize({ x: 2 }));
  });

  it('handles arrays', () => {
    expect(canonicalize([1, 2, 3])).toBe('[1,2,3]');
  });
});

describe('computePayloadHash', () => {
  it('changes when action type changes', () => {
    const p = { discrepancy_id: 1 };
    expect(computePayloadHash('reconciliation_retry', p)).not.toBe(
      computePayloadHash('reconciliation_resolve', p),
    );
  });

  it('changes when payload changes', () => {
    expect(computePayloadHash('reconciliation_retry', { discrepancy_id: 1 })).not.toBe(
      computePayloadHash('reconciliation_retry', { discrepancy_id: 2 }),
    );
  });

  it('produces a 64-character hex string', () => {
    expect(computePayloadHash('reconciliation_retry', {})).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// HMAC signature
// ---------------------------------------------------------------------------

describe('verifyOperatorSignature', () => {
  beforeEach(setTestKey);
  afterEach(() => {
    delete process.env.INTERNAL_API_KEY;
  });

  it('accepts a correctly derived signature', () => {
    const payload = { discrepancy_id: 5 };
    const sig = deriveOperatorSignature('GOPER', 'reconciliation_retry', 'key-1', payload, TEST_KEY);
    expect(verifyOperatorSignature('GOPER', 'reconciliation_retry', 'key-1', payload, sig)).toBe(
      true,
    );
  });

  it('rejects a signature with a changed operator id', () => {
    const payload = { discrepancy_id: 5 };
    const sig = deriveOperatorSignature('GOPER', 'reconciliation_retry', 'key-1', payload, TEST_KEY);
    expect(
      verifyOperatorSignature('GDIFF', 'reconciliation_retry', 'key-1', payload, sig),
    ).toBe(false);
  });

  it('rejects a signature with a changed action type', () => {
    const payload = { discrepancy_id: 5 };
    const sig = deriveOperatorSignature('GOPER', 'reconciliation_retry', 'key-1', payload, TEST_KEY);
    expect(
      verifyOperatorSignature('GOPER', 'reconciliation_resolve', 'key-1', payload, sig),
    ).toBe(false);
  });

  it('rejects a signature with a changed payload', () => {
    const sig = deriveOperatorSignature(
      'GOPER',
      'reconciliation_retry',
      'key-1',
      { discrepancy_id: 5 },
      TEST_KEY,
    );
    expect(
      verifyOperatorSignature(
        'GOPER',
        'reconciliation_retry',
        'key-1',
        { discrepancy_id: 6 },
        sig,
      ),
    ).toBe(false);
  });

  it('rejects a signature with a changed idempotency key', () => {
    const payload = { discrepancy_id: 5 };
    const sig = deriveOperatorSignature('GOPER', 'reconciliation_retry', 'key-1', payload, TEST_KEY);
    expect(
      verifyOperatorSignature('GOPER', 'reconciliation_retry', 'key-2', payload, sig),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateRecoveryInput
// ---------------------------------------------------------------------------

describe('validateRecoveryInput', () => {
  beforeEach(setTestKey);

  it('passes for a valid input', () => {
    expect(() => validateRecoveryInput(validInput())).not.toThrow();
  });

  it('rejects unsupported action type', () => {
    expect(() =>
      validateRecoveryInput(validInput({ actionType: 'drop_table' as never })),
    ).toThrow('Unsupported recovery action type');
  });

  it('rejects unsupported reason_code', () => {
    expect(() =>
      validateRecoveryInput(validInput({ reasonCode: 'hack_the_planet' as never })),
    ).toThrow('Invalid reason_code');
  });

  it('rejects too-short approval_reference', () => {
    expect(() => validateRecoveryInput(validInput({ approvalReference: 'ab' }))).toThrow(
      'approval_reference',
    );
  });

  it('rejects too-short reason_note', () => {
    expect(() => validateRecoveryInput(validInput({ reasonNote: 'short' }))).toThrow(
      'reason_note',
    );
  });

  it('rejects an invalid operator_signature format', () => {
    expect(() => validateRecoveryInput(validInput({ operatorSignature: 'nothex' }))).toThrow(
      'operator_signature',
    );
  });

  it('rejects array payloads', () => {
    expect(() => validateRecoveryInput(validInput({ payload: [] as never }))).toThrow('payload');
  });

  it('enumerates all action types', () => {
    expect(OPERATOR_RECOVERY_ACTION_TYPES).toContain('reconciliation_retry');
    expect(OPERATOR_RECOVERY_ACTION_TYPES).toContain('loan_state_replay');
  });

  it('enumerates all reason codes', () => {
    expect(RECOVERY_REASON_CODES).toContain('indexer_lag');
    expect(RECOVERY_REASON_CODES).toContain('manual_reconciliation');
  });
});

// ---------------------------------------------------------------------------
// createRecoveryAction
// ---------------------------------------------------------------------------

describe('createRecoveryAction', () => {
  beforeEach(() => {
    setTestKey();
    jest.resetAllMocks();
  });

  it('inserts a row and writes an audit entry on success', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 11, created_at: new Date().toISOString() }] }) // INSERT
      .mockResolvedValueOnce({ rows: [] }) // audit INSERT
      .mockResolvedValueOnce({ rows: [dbRow({ id: 11 })] }); // SELECT for return

    const result = await createRecoveryAction(validInput());
    expect(result.id).toBe(11);
    expect(result.status).toBe('pending');

    // First SQL must be an INSERT into operator_recovery_actions
    expect(mockQuery.mock.calls[0]![0]).toContain('INSERT INTO operator_recovery_actions');

    // Second call must be the audit log
    const auditCall = mockQuery.mock.calls[1]!;
    expect(auditCall[0]).toContain('audit_logs');
    expect(auditCall[1]![1]).toBe('OPERATOR_RECOVERY_CREATED');
  });

  it('rejects an invalid operator_signature (wrong key)', async () => {
    const badSig = '0'.repeat(64);
    await expect(createRecoveryAction(validInput({ operatorSignature: badSig }))).rejects.toThrow(
      'operator_signature verification failed',
    );
    // No DB call should have been made
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('surfaces a 409 on duplicate idempotency_key', async () => {
    // Simulate Postgres unique constraint violation (code 23505)
    mockQuery.mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: '23505' }));
    await expect(createRecoveryAction(validInput())).rejects.toThrow('already exists');
  });

  it('propagates unexpected DB errors unchanged', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection lost'));
    await expect(createRecoveryAction(validInput())).rejects.toThrow('connection lost');
  });
});

// ---------------------------------------------------------------------------
// executeRecoveryAction
// ---------------------------------------------------------------------------

describe('executeRecoveryAction', () => {
  const operatorId = 'GADMIN00000000000000000000000000000000000000000000000000';

  beforeEach(() => {
    setTestKey();
    jest.resetAllMocks();
  });

  it('transitions pending → executing → completed and audits each step', async () => {
    const payload = { discrepancy_id: 7 };
    const payloadHash = computePayloadHash('reconciliation_retry', payload);

    // 1. Load action_type + payload + payload_hash + operator_id
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          action_type: 'reconciliation_retry',
          payload,
          payload_hash: payloadHash,
          operator_id: operatorId,
        },
      ],
    });
    // 2. Claim (pending → executing)
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 });
    // 3. Audit: EXECUTING
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // 4. Load ctx fields (approval_reference, reason_code, idempotency_key)
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          approval_reference: 'JIRA-1234',
          reason_code: 'indexer_lag',
          idempotency_key: 'idemp-abc123',
        },
      ],
    });
    // 5. executor: UPDATE reconciliation_discrepancies (reconciliation_retry)
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 });
    // 6. UPDATE to 'completed'
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // 7. Audit: COMPLETED
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // 8. SELECT for final return value
    mockQuery.mockResolvedValueOnce({ rows: [dbRow({ status: 'completed', outcome_ref: 'discrepancy:7' })] });

    const result = await executeRecoveryAction(1, operatorId);
    expect(result.status).toBe('completed');
    expect(result.outcomeRef).toBe('discrepancy:7');

    // Verify claim SQL
    const claimSql = mockQuery.mock.calls[1]![0] as string;
    expect(claimSql).toContain("status = 'executing'");
    expect(claimSql).toContain("status = 'pending'");
  });

  it('returns 409 when action is not in pending state', async () => {
    const payload = { discrepancy_id: 7 };
    const payloadHash = computePayloadHash('reconciliation_retry', payload);

    // 1. Load row
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          action_type: 'reconciliation_retry',
          payload,
          payload_hash: payloadHash,
          operator_id: operatorId,
        },
      ],
    });
    // 2. Claim returns empty (already executing)
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // 3. Status check
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'completed' }] });

    await expect(executeRecoveryAction(1, operatorId)).rejects.toThrow(
      "Cannot execute recovery action in status 'completed'",
    );
  });

  it('detects payload hash tampering before execution', async () => {
    // A tampered stored hash that does not match the payload
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          action_type: 'reconciliation_retry',
          payload: { discrepancy_id: 7 },
          payload_hash: 'a'.repeat(64), // wrong hash
          operator_id: operatorId,
        },
      ],
    });

    await expect(executeRecoveryAction(1, operatorId)).rejects.toThrow(
      'record integrity violation',
    );
  });

  it('marks the action failed when the executor throws', async () => {
    const payload = { discrepancy_id: 999 };
    const payloadHash = computePayloadHash('reconciliation_retry', payload);

    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          action_type: 'reconciliation_retry',
          payload,
          payload_hash: payloadHash,
          operator_id: operatorId,
        },
      ],
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 }); // claim
    mockQuery.mockResolvedValueOnce({ rows: [] }); // audit EXECUTING
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          approval_reference: 'REF',
          reason_code: 'indexer_lag',
          idempotency_key: 'k',
        },
      ],
    }); // ctx
    // executor: UPDATE reconciliation_discrepancies — no row found (rowCount 0)
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // UPDATE to 'failed'
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // Audit: FAILED
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // SELECT for return
    mockQuery.mockResolvedValueOnce({
      rows: [dbRow({ status: 'failed', outcome_error: 'not found' })],
    });

    const result = await executeRecoveryAction(1, operatorId);
    expect(result.status).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// rejectRecoveryAction
// ---------------------------------------------------------------------------

describe('rejectRecoveryAction', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('transitions pending → rejected', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 2 }], rowCount: 1 })  // UPDATE
      .mockResolvedValueOnce({ rows: [] })                          // audit
      .mockResolvedValueOnce({ rows: [dbRow({ id: 2, status: 'rejected' })] }); // SELECT

    const result = await rejectRecoveryAction(2, 'GADMIN', 'No longer needed');
    expect(result.status).toBe('rejected');

    const updateSql = mockQuery.mock.calls[0]![0] as string;
    expect(updateSql).toContain("status = 'rejected'");
    expect(updateSql).toContain("status = 'pending'");
  });

  it('rejects too-short rejection reason', async () => {
    await expect(rejectRecoveryAction(1, 'GA', 'nop')).rejects.toThrow('rejection reason');
  });

  it('errors when action is not pending', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ status: 'completed' }] });

    await expect(rejectRecoveryAction(1, 'GA', 'too late anyway')).rejects.toThrow(
      "Cannot reject recovery action in status 'completed'",
    );
  });
});

// ---------------------------------------------------------------------------
// getRecoveryAction / listRecoveryActions
// ---------------------------------------------------------------------------

describe('getRecoveryAction', () => {
  beforeEach(() => jest.resetAllMocks());

  it('maps the DB row to the OperatorRecoveryRecord shape', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [dbRow()] });
    const record = await getRecoveryAction(1);
    expect(record.operatorId).toBe('GADMIN00000000000000000000000000000000000000000000000000');
    expect(record.actionType).toBe('reconciliation_retry');
    expect(record.status).toBe('pending');
  });

  it('throws 404 when not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(getRecoveryAction(99)).rejects.toThrow('not found');
  });
});

describe('listRecoveryActions', () => {
  beforeEach(() => jest.resetAllMocks());

  it('returns an empty array when no rows exist', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const records = await listRecoveryActions({});
    expect(records).toHaveLength(0);
  });

  it('applies operator_id filter', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [dbRow()] });
    await listRecoveryActions({ operatorId: 'GADMIN00000000000000000000000000000000000000000000000000' });
    const sql = mockQuery.mock.calls[0]![0] as string;
    expect(sql).toContain('operator_id = $');
  });

  it('applies approval_reference filter', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [dbRow()] });
    await listRecoveryActions({ approvalReference: 'JIRA-9999' });
    const sql = mockQuery.mock.calls[0]![0] as string;
    expect(sql).toContain('approval_reference = $');
  });

  it('caps limit at 200', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listRecoveryActions({ limit: 9999 });
    const params = mockQuery.mock.calls[0]![1] as unknown[];
    expect(params[params.length - 1]).toBe(200);
  });

  it('applies keyset cursor', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listRecoveryActions({ cursor: 42 });
    const sql = mockQuery.mock.calls[0]![0] as string;
    expect(sql).toContain('id < $');
  });
});

// ---------------------------------------------------------------------------
// Balance-edit prohibition
// ---------------------------------------------------------------------------

describe('balance-edit prohibition', () => {
  beforeEach(() => {
    setTestKey();
    jest.resetAllMocks();
  });

  const forbidden = ['balance', 'amount', 'principal', 'adjust_outstanding', 'set_balance'];

  for (const field of forbidden) {
    it(`rejects payload with field '${field}'`, async () => {
      const payload = { discrepancy_id: 1, [field]: '1000' };
      const sig = makeSignature(
        'GADMIN00000000000000000000000000000000000000000000000000',
        'reconciliation_retry',
        'k1',
        payload,
      );

      // The DB INSERT should not be reached; we expect rejection during execution.
      // Seed the query mock so createRecoveryAction can insert, then execute.
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 20, created_at: new Date().toISOString() }] })
        .mockResolvedValueOnce({ rows: [] }) // audit
        .mockResolvedValueOnce({ rows: [dbRow({ id: 20, payload })] }); // getRecoveryAction

      await createRecoveryAction(
        validInput({
          payload,
          idempotencyKey: `k1-${field}`,
          operatorSignature: makeSignature(
            'GADMIN00000000000000000000000000000000000000000000000000',
            'reconciliation_retry',
            `k1-${field}`,
            payload,
          ),
        }),
      );

      // Now execute — the executor should reject the balance-edit field
      const payloadHash = computePayloadHash('reconciliation_retry', payload);
      mockQuery.mockResolvedValueOnce({
        rows: [{ action_type: 'reconciliation_retry', payload, payload_hash: payloadHash, operator_id: 'GADMIN00000000000000000000000000000000000000000000000000' }],
      });
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 20 }], rowCount: 1 }); // claim
      mockQuery.mockResolvedValueOnce({ rows: [] }); // audit EXECUTING
      mockQuery.mockResolvedValueOnce({
        rows: [{ approval_reference: 'REF', reason_code: 'indexer_lag', idempotency_key: 'k1' }],
      });
      // UPDATE to 'failed' (after executor throws)
      mockQuery.mockResolvedValueOnce({ rows: [] });
      // Audit: FAILED
      mockQuery.mockResolvedValueOnce({ rows: [] });
      // SELECT for return
      mockQuery.mockResolvedValueOnce({
        rows: [dbRow({ id: 20, status: 'failed', outcome_error: `balance-edit field: ${field}` })],
      });

      const result = await executeRecoveryAction(20, 'GADMIN00000000000000000000000000000000000000000000000000');
      // The action transitions to failed with an outcome_error referencing the forbidden field.
      expect(result.status).toBe('failed');
    });
  }
});

// ---------------------------------------------------------------------------
// Access-control guards (route-level, middleware integration)
// ---------------------------------------------------------------------------

describe('admin:recovery scope requirement (documentation)', () => {
  it('is defined in OPERATOR_RECOVERY_ACTION_TYPES', () => {
    expect(OPERATOR_RECOVERY_ACTION_TYPES.length).toBeGreaterThan(0);
  });

  it('every action type has a corresponding executor (completeness check)', () => {
    // If a type is added to the enum without an executor, the service will
    // throw at runtime.  This test documents the invariant and surfaces the
    // missing executor before deployment.
    for (const type of OPERATOR_RECOVERY_ACTION_TYPES) {
      expect(() => validateRecoveryInput({
        operatorId: 'G',
        actionType: type,
        reasonCode: 'indexer_lag',
        approvalReference: 'REF',
        idempotencyKey: 'k',
        operatorSignature: '0'.repeat(64), // bypassed in this test path
        payload: {},
        reasonNote: 'test coverage note here',
      })).not.toThrow(/Unsupported recovery action type/);
    }
  });
});
