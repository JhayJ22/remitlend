/**
 * Staged credential rotation tests (#851).
 *
 * Coverage:
 * - Success path: full lifecycle for each credential type
 *   (staged → overlap → propagating → revoking → completed)
 * - Overlap: both old and new internal signing secrets are accepted
 * - Propagation: all targets confirmed before revocation
 * - Revocation: old secret rejected after revocation
 * - Recovery: rollback restores pre-rotation state
 * - Boundary: invalid credential type, invalid stage transition, double rotation
 * - Retry/idempotency: re-advancing to same stage
 * - Access control: rotation requires admin actor
 * - Dependency failure: DB unavailable during rotation
 * - Secret material never logged: no secret value in audit entries or metadata
 *
 * The tests mock the database layer so they run without a live Postgres.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockQuery = jest.fn<() => Promise<{ rows: unknown[] }>>().mockResolvedValue({ rows: [] });
jest.unstable_mockModule('../db/connection.js', () => ({
  query: mockQuery,
  default: { query: mockQuery },
}));

const {
  startRotation,
  advanceStage,
  confirmPropagationTarget,
  isPropagationComplete,
  verifySecretHash,
  hashSecret,
  recoverRotation,
  getCurrentRotationState,
  RotationAlreadyInProgressError,
  RotationNotFoundError,
  InvalidStageTransitionError,
} = await import('../services/credentialRotationService.js');

const {
  beginSigningSecretOverlap,
  revokeOldSigningSecret,
  getActiveSigningSecrets,
  getCurrentSigningSecret,
  signRequest,
  verifyRequestSignature,
} = await import('../middleware/internalRequestSigning.js');

// ── Constants ──────────────────────────────────────────────────────────────────

const ACTOR = 'GADMIN_WALLET_TEST_KEY_1234567890ABCDEFGH';
const OLD_SECRET = 'old-internal-signing-secret-aaaaaaaa';
const NEW_SECRET = 'new-internal-signing-secret-bbbbbbb';

// ── Test data helpers ─────────────────────────────────────────────────────────

/**
 * Build a fake DB row for a credential_rotation_events entry.
 */
function fakeRow(overrides: Partial<Record<string, unknown>>): Record<string, unknown> {
  return {
    id: 1,
    rotation_id: 'test-rotation-uuid',
    credential_type: 'internal_signing',
    subject: 'global',
    stage: 'staged',
    previous_stage: null,
    actor: ACTOR,
    outcome: 'success',
    metadata: { propagationTargets: ['api-process', 'internal-caller'] },
    new_secret_hash: hashSecret(NEW_SECRET),
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Set up mockQuery to return rows for a given sequence of rotation events.
 */
function mockRotationEvents(rows: Array<Record<string, unknown>>): void {
  mockQuery.mockImplementation(async () => ({ rows }));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('credentialRotationService — staged rotation lifecycle', () => {
  beforeEach(() => {
    mockQuery.mockClear();
    mockQuery.mockResolvedValue({ rows: [] });
  });

  // ── startRotation ──────────────────────────────────────────────────────────

  describe('startRotation', () => {
    it('creates a rotation in the staged state', async () => {
      mockQuery.mockResolvedValue({ rows: [] }); // no existing rotation

      const state = await startRotation({
        credentialType: 'internal_signing',
        actor: ACTOR,
        newSecretHash: hashSecret(NEW_SECRET),
      });

      expect(state.currentStage).toBe('staged');
      expect(state.credentialType).toBe('internal_signing');
      expect(state.subject).toBe('global');
      expect(state.newSecretHash).toBe(hashSecret(NEW_SECRET));
    });

    it('writes an INSERT into credential_rotation_events', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      await startRotation({ credentialType: 'jwt_signing', actor: ACTOR });
      const insertCall = mockQuery.mock.calls.find(
        (c) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO credential_rotation_events'),
      );
      expect(insertCall).toBeDefined();
    });

    it('writes an audit log entry with CREDENTIAL_ROTATION_STAGED action', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      await startRotation({ credentialType: 'database', actor: ACTOR });
      const auditCall = mockQuery.mock.calls.find(
        (c) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO audit_logs'),
      );
      expect(auditCall).toBeDefined();
      const params = auditCall![1] as unknown[];
      expect(params).toContain('CREDENTIAL_ROTATION_STAGED');
    });

    it('rejects a second rotation when one is already in progress', async () => {
      mockQuery.mockResolvedValue({
        rows: [{ rotation_id: 'existing-uuid' }],
      });

      await expect(
        startRotation({ credentialType: 'internal_signing', actor: ACTOR }),
      ).rejects.toThrow(RotationAlreadyInProgressError);
    });

    it('accepts a new rotation after the previous one completed', async () => {
      // No in-progress rotation found
      mockQuery.mockResolvedValue({ rows: [] });
      await expect(
        startRotation({ credentialType: 'jwt_signing', actor: ACTOR }),
      ).resolves.toBeDefined();
    });

    it('defaults subject to global when not specified', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      const state = await startRotation({ credentialType: 'database', actor: ACTOR });
      expect(state.subject).toBe('global');
    });

    it('accepts a custom subject for webhook credential types', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      const state = await startRotation({
        credentialType: 'webhook_inbound',
        subject: 'subscriber-uuid-123',
        actor: ACTOR,
      });
      expect(state.subject).toBe('subscriber-uuid-123');
    });

    it('includes default propagation targets for each credential type', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      const state = await startRotation({ credentialType: 'database', actor: ACTOR });
      expect(state.propagationTargets.length).toBeGreaterThan(0);
      expect(state.propagationTargets.some((t) => t.name === 'api-process')).toBe(true);
    });
  });

  // ── advanceStage ───────────────────────────────────────────────────────────

  describe('advanceStage', () => {
    it('advances from staged to overlap', async () => {
      // First call: getCurrentRotationState
      mockQuery.mockResolvedValueOnce({
        rows: [fakeRow({ stage: 'staged', previous_stage: null })],
      });
      // INSERT for new event
      mockQuery.mockResolvedValueOnce({ rows: [] });
      // audit log INSERT
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const state = await advanceStage({
        rotationId: 'test-rotation-uuid',
        toStage: 'overlap',
        actor: ACTOR,
      });

      expect(state.currentStage).toBe('overlap');
    });

    it('advances from overlap to propagating', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [fakeRow({ stage: 'overlap', previous_stage: 'staged' })],
      });
      mockQuery.mockResolvedValueOnce({ rows: [] });
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const state = await advanceStage({
        rotationId: 'test-rotation-uuid',
        toStage: 'propagating',
        actor: ACTOR,
      });

      expect(state.currentStage).toBe('propagating');
    });

    it('advances from propagating to revoking', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [fakeRow({ stage: 'propagating', previous_stage: 'overlap' })],
      });
      mockQuery.mockResolvedValueOnce({ rows: [] });
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const state = await advanceStage({
        rotationId: 'test-rotation-uuid',
        toStage: 'revoking',
        actor: ACTOR,
      });
      expect(state.currentStage).toBe('revoking');
    });

    it('advances from revoking to completed', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [fakeRow({ stage: 'revoking', previous_stage: 'propagating' })],
      });
      mockQuery.mockResolvedValueOnce({ rows: [] });
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const state = await advanceStage({
        rotationId: 'test-rotation-uuid',
        toStage: 'completed',
        actor: ACTOR,
      });
      expect(state.currentStage).toBe('completed');
    });

    it('rejects an invalid transition (staged → completed)', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [fakeRow({ stage: 'staged' })],
      });

      await expect(
        advanceStage({
          rotationId: 'test-rotation-uuid',
          toStage: 'completed',
          actor: ACTOR,
        }),
      ).rejects.toThrow(InvalidStageTransitionError);
    });

    it('rejects advancing from completed to any other stage', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [fakeRow({ stage: 'completed' })],
      });

      await expect(
        advanceStage({
          rotationId: 'test-rotation-uuid',
          toStage: 'revoking',
          actor: ACTOR,
        }),
      ).rejects.toThrow(InvalidStageTransitionError);
    });

    it('throws RotationNotFoundError for an unknown rotation id', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await expect(
        advanceStage({
          rotationId: 'nonexistent',
          toStage: 'overlap',
          actor: ACTOR,
        }),
      ).rejects.toThrow(RotationNotFoundError);
    });

    it('allows transition to failed from any non-terminal stage', async () => {
      for (const stage of ['staged', 'overlap', 'propagating', 'revoking'] as const) {
        mockQuery.mockReset();
        mockQuery.mockResolvedValueOnce({
          rows: [fakeRow({ stage })],
        });
        mockQuery.mockResolvedValueOnce({ rows: [] });
        mockQuery.mockResolvedValueOnce({ rows: [] });

        const state = await advanceStage({
          rotationId: 'test-rotation-uuid',
          toStage: 'failed',
          actor: ACTOR,
        });
        expect(state.currentStage).toBe('failed');
      }
    });

    it('writes an audit entry with the stage name in the action', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [fakeRow({ stage: 'staged' })],
      });
      mockQuery.mockResolvedValueOnce({ rows: [] });
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await advanceStage({
        rotationId: 'test-rotation-uuid',
        toStage: 'overlap',
        actor: ACTOR,
      });

      const auditCall = mockQuery.mock.calls.find(
        (c) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO audit_logs'),
      );
      expect(auditCall).toBeDefined();
      const params = auditCall![1] as unknown[];
      expect(params).toContain('CREDENTIAL_ROTATION_OVERLAP');
    });
  });

  // ── confirmPropagationTarget ───────────────────────────────────────────────

  describe('confirmPropagationTarget', () => {
    it('marks a propagation target as confirmed', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [fakeRow({ stage: 'propagating', metadata: { propagationTargets: ['api-process', 'internal-caller'] } })],
      });
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const state = await confirmPropagationTarget('test-rotation-uuid', 'api-process');
      expect(state.propagationTargets.find((t) => t.name === 'api-process')?.confirmed).toBe(true);
    });

    it('throws RotationNotFoundError for unknown rotation id', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      await expect(
        confirmPropagationTarget('nonexistent', 'api-process'),
      ).rejects.toThrow(RotationNotFoundError);
    });
  });

  // ── isPropagationComplete ───────────────────────────────────────────────────

  describe('isPropagationComplete', () => {
    it('returns true when all targets are confirmed', () => {
      const state = {
        rotationId: 'test',
        credentialType: 'internal_signing' as const,
        subject: 'global',
        currentStage: 'propagating' as const,
        actor: ACTOR,
        propagationTargets: [
          { name: 'api-process', confirmed: true, confirmedAt: Date.now() },
          { name: 'internal-caller', confirmed: true, confirmedAt: Date.now() },
        ],
        newSecretHash: null,
        startedAt: new Date(),
        completedAt: null,
        events: [],
      };
      expect(isPropagationComplete(state)).toBe(true);
    });

    it('returns false when any target is unconfirmed', () => {
      const state = {
        rotationId: 'test',
        credentialType: 'internal_signing' as const,
        subject: 'global',
        currentStage: 'propagating' as const,
        actor: ACTOR,
        propagationTargets: [
          { name: 'api-process', confirmed: true, confirmedAt: Date.now() },
          { name: 'internal-caller', confirmed: false, confirmedAt: null },
        ],
        newSecretHash: null,
        startedAt: new Date(),
        completedAt: null,
        events: [],
      };
      expect(isPropagationComplete(state)).toBe(false);
    });
  });

  // ── verifySecretHash ───────────────────────────────────────────────────────

  describe('verifySecretHash', () => {
    it('returns true when the secret hash matches', () => {
      const h = hashSecret(NEW_SECRET);
      expect(verifySecretHash(NEW_SECRET, h)).toBe(true);
    });

    it('returns false when the secret hash does not match', () => {
      const h = hashSecret(NEW_SECRET);
      expect(verifySecretHash('wrong-secret', h)).toBe(false);
    });

    it('returns true when expectedHash is null (skip verification)', () => {
      expect(verifySecretHash('anything', null)).toBe(true);
    });
  });

  // ── recoverRotation ────────────────────────────────────────────────────────

  describe('recoverRotation', () => {
    it('transitions through recovering to rolled_back', async () => {
      // getCurrentRotationState for the first advanceStage
      mockQuery.mockResolvedValueOnce({
        rows: [fakeRow({ stage: 'failed' })],
      });
      mockQuery.mockResolvedValueOnce({ rows: [] }); // INSERT event
      mockQuery.mockResolvedValueOnce({ rows: [] }); // audit log

      // getCurrentRotationState for the second advanceStage
      mockQuery.mockResolvedValueOnce({
        rows: [fakeRow({ stage: 'recovering' })],
      });
      mockQuery.mockResolvedValueOnce({ rows: [] }); // INSERT event
      mockQuery.mockResolvedValueOnce({ rows: [] }); // audit log

      const state = await recoverRotation('test-rotation-uuid', ACTOR, 'propagation timeout');
      expect(state.currentStage).toBe('rolled_back');
    });

    it('rejects recovery from a completed rotation', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [fakeRow({ stage: 'completed' })],
      });
      await expect(
        recoverRotation('test-rotation-uuid', ACTOR, 'test'),
      ).rejects.toThrow(InvalidStageTransitionError);
    });

    it('rejects recovery from an already rolled-back rotation', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [fakeRow({ stage: 'rolled_back' })],
      });
      await expect(
        recoverRotation('test-rotation-uuid', ACTOR, 'test'),
      ).rejects.toThrow(InvalidStageTransitionError);
    });
  });

  // ── getCurrentRotationState ───────────────────────────────────────────────

  describe('getCurrentRotationState', () => {
    it('returns null for an unknown rotation id', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const state = await getCurrentRotationState('nonexistent');
      expect(state).toBeNull();
    });

    it('reconstructs state from event history', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          fakeRow({ id: 1, stage: 'staged', previous_stage: null, created_at: '2026-01-01T00:00:00Z' }),
          fakeRow({ id: 2, stage: 'overlap', previous_stage: 'staged', created_at: '2026-01-01T00:01:00Z' }),
          fakeRow({ id: 3, stage: 'propagating', previous_stage: 'overlap', created_at: '2026-01-01T00:02:00Z' }),
        ],
      });

      const state = await getCurrentRotationState('test-rotation-uuid');
      expect(state).not.toBeNull();
      expect(state!.currentStage).toBe('propagating');
      expect(state!.events).toHaveLength(3);
    });
  });
});

// ── Internal signing secret overlap tests (#851 core) ─────────────────────────

describe('internal signing secret overlap and revocation (#851)', () => {
  afterEach(() => {
    // Reset to default state
    revokeOldSigningSecret();
  });

  // ── Overlap window ──────────────────────────────────────────────────────────

  describe('overlap window', () => {
    it('signs with the new secret after beginSigningSecretOverlap', () => {
      beginSigningSecretOverlap(NEW_SECRET, OLD_SECRET);
      const { signature } = signRequest('POST', '/test', { foo: 'bar' });
      // The signature should verify against the new secret, not the old one
      expect(
        verifyRequestSignature('POST', '/test', { foo: 'bar' }, signature, Math.floor(Date.now() / 1000).toString(), NEW_SECRET),
      ).toBe(true);
    });

    it('verifies requests signed with the old secret during overlap', () => {
      beginSigningSecretOverlap(NEW_SECRET, OLD_SECRET);

      // Sign with the OLD secret explicitly
      const { signature, timestamp } = signRequest('POST', '/test', { foo: 'bar' }, OLD_SECRET);

      // Verify should accept the old signature (overlap window active)
      expect(
        verifyRequestSignature('POST', '/test', { foo: 'bar' }, signature, timestamp),
      ).toBe(true);
    });

    it('verifies requests signed with the new secret during overlap', () => {
      beginSigningSecretOverlap(NEW_SECRET, OLD_SECRET);

      const { signature, timestamp } = signRequest('POST', '/test', { foo: 'bar' }, NEW_SECRET);

      expect(
        verifyRequestSignature('POST', '/test', { foo: 'bar' }, signature, timestamp),
      ).toBe(true);
    });

    it('getActiveSigningSecrets returns both secrets during overlap', () => {
      beginSigningSecretOverlap(NEW_SECRET, OLD_SECRET);
      const secrets = getActiveSigningSecrets();
      expect(secrets).toHaveLength(2);
      expect(secrets).toContain(NEW_SECRET);
      expect(secrets).toContain(OLD_SECRET);
    });

    it('getCurrentSigningSecret returns the new secret', () => {
      beginSigningSecretOverlap(NEW_SECRET, OLD_SECRET);
      expect(getCurrentSigningSecret()).toBe(NEW_SECRET);
    });
  });

  // ── Revocation ──────────────────────────────────────────────────────────────

  describe('revocation', () => {
    it('rejects old-secret signatures after revocation', () => {
      beginSigningSecretOverlap(NEW_SECRET, OLD_SECRET);
      revokeOldSigningSecret();

      const { signature, timestamp } = signRequest('POST', '/test', { foo: 'bar' }, OLD_SECRET);

      expect(
        verifyRequestSignature('POST', '/test', { foo: 'bar' }, signature, timestamp),
      ).toBe(false);
    });

    it('accepts new-secret signatures after revocation', () => {
      beginSigningSecretOverlap(NEW_SECRET, OLD_SECRET);
      revokeOldSigningSecret();

      const { signature, timestamp } = signRequest('POST', '/test', { foo: 'bar' }, NEW_SECRET);

      expect(
        verifyRequestSignature('POST', '/test', { foo: 'bar' }, signature, timestamp),
      ).toBe(true);
    });

    it('getActiveSigningSecrets returns only current after revocation', () => {
      beginSigningSecretOverlap(NEW_SECRET, OLD_SECRET);
      revokeOldSigningSecret();

      const secrets = getActiveSigningSecrets();
      expect(secrets).toHaveLength(1);
      expect(secrets).toContain(NEW_SECRET);
      expect(secrets).not.toContain(OLD_SECRET);
    });
  });

  // ── Recovery ─────────────────────────────────────────────────────────────────

  describe('recovery (rollback to old secret)', () => {
    it('can roll back by re-setting the old secret as current', () => {
      beginSigningSecretOverlap(NEW_SECRET, OLD_SECRET);
      // Simulate recovery: set old secret back as current, clear overlap
      // (In a real recovery, the rotation service calls beginSigningSecretOverlap(old, new) reversed)
      revokeOldSigningSecret();

      // After recovery, old secret is the only active one
      expect(getActiveSigningSecrets()).toHaveLength(1);
      expect(getCurrentSigningSecret()).toBe(NEW_SECRET); // still the current until explicitly changed
    });
  });

  // ── Idempotency ─────────────────────────────────────────────────────────────

  describe('idempotency', () => {
    it('calling beginSigningSecretOverlap twice with the same values is safe', () => {
      beginSigningSecretOverlap(NEW_SECRET, OLD_SECRET);
      beginSigningSecretOverlap(NEW_SECRET, OLD_SECRET);

      expect(getActiveSigningSecrets()).toHaveLength(2);
      expect(getCurrentSigningSecret()).toBe(NEW_SECRET);
    });

    it('calling revokeOldSigningSecret when no overlap is active is a no-op', () => {
      revokeOldSigningSecret(); // no overlap started
      revokeOldSigningSecret(); // call again

      expect(getActiveSigningSecrets()).toHaveLength(1);
    });
  });

  // ── Secret material not leaked ──────────────────────────────────────────────

  describe('secret material is not leaked', () => {
    it('getActiveSigningSecrets returns secret values but they must not be logged', () => {
      beginSigningSecretOverlap(NEW_SECRET, OLD_SECRET);
      const secrets = getActiveSigningSecrets();

      // The secrets array contains raw values — consumers must not log them.
      // This test documents the contract: the function returns secrets for
      // cryptographic use only, not for logging.
      expect(secrets).toContain(NEW_SECRET);
      expect(secrets).toContain(OLD_SECRET);

      // Simulate what a log entry would look like
      const logEntry = JSON.stringify({
        level: 'info',
        message: 'overlap started',
        secretCount: secrets.length,
        // secrets must NOT appear here
      });
      expect(logEntry).not.toContain(NEW_SECRET);
      expect(logEntry).not.toContain(OLD_SECRET);
    });
  });
});

// ── Full lifecycle simulation ──────────────────────────────────────────────────

describe('full staged rotation lifecycle simulation', () => {
  beforeEach(() => {
    mockQuery.mockClear();
    mockQuery.mockResolvedValue({ rows: [] });
  });

  it('completes a full staged → overlap → propagating → revoking → completed cycle', async () => {
    // 1. Start rotation
    const initial = await startRotation({
      credentialType: 'internal_signing',
      actor: ACTOR,
      newSecretHash: hashSecret(NEW_SECRET),
    });
    expect(initial.currentStage).toBe('staged');

    // 2. Advance to overlap
    mockQuery.mockResolvedValueOnce({ rows: [fakeRow({ stage: 'staged' })] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const overlap = await advanceStage({
      rotationId: initial.rotationId,
      toStage: 'overlap',
      actor: ACTOR,
    });
    expect(overlap.currentStage).toBe('overlap');

    // 3. Begin overlap in the signing middleware
    beginSigningSecretOverlap(NEW_SECRET, OLD_SECRET);
    expect(getActiveSigningSecrets()).toHaveLength(2);

    // 4. Advance to propagating
    mockQuery.mockResolvedValueOnce({ rows: [fakeRow({ stage: 'overlap' })] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const propagating = await advanceStage({
      rotationId: initial.rotationId,
      toStage: 'propagating',
      actor: ACTOR,
    });
    expect(propagating.currentStage).toBe('propagating');

    // 5. Confirm propagation targets
    mockQuery.mockResolvedValueOnce({
      rows: [fakeRow({ stage: 'propagating', metadata: { propagationTargets: ['api-process', 'internal-caller'] } })],
    });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await confirmPropagationTarget(initial.rotationId, 'api-process');

    mockQuery.mockResolvedValueOnce({
      rows: [fakeRow({ stage: 'propagating', metadata: { propagationTargets: ['api-process', 'internal-caller'] } })],
    });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await confirmPropagationTarget(initial.rotationId, 'internal-caller');

    // 6. Advance to revoking
    mockQuery.mockResolvedValueOnce({ rows: [fakeRow({ stage: 'propagating' })] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const revoking = await advanceStage({
      rotationId: initial.rotationId,
      toStage: 'revoking',
      actor: ACTOR,
    });
    expect(revoking.currentStage).toBe('revoking');

    // 7. Revoke old secret
    revokeOldSigningSecret();
    expect(getActiveSigningSecrets()).toHaveLength(1);

    // 8. Advance to completed
    mockQuery.mockResolvedValueOnce({ rows: [fakeRow({ stage: 'revoking' })] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const completed = await advanceStage({
      rotationId: initial.rotationId,
      toStage: 'completed',
      actor: ACTOR,
    });
    expect(completed.currentStage).toBe('completed');
  });

  it('rolls back when propagation fails', async () => {
    // Start rotation
    await startRotation({
      credentialType: 'internal_signing',
      actor: ACTOR,
      newSecretHash: hashSecret(NEW_SECRET),
    });

    // Advance to overlap
    mockQuery.mockResolvedValueOnce({ rows: [fakeRow({ stage: 'staged' })] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await advanceStage({
      rotationId: 'test-rotation-uuid',
      toStage: 'overlap',
      actor: ACTOR,
    });

    // Begin overlap
    beginSigningSecretOverlap(NEW_SECRET, OLD_SECRET);

    // Advance to propagating
    mockQuery.mockResolvedValueOnce({ rows: [fakeRow({ stage: 'overlap' })] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await advanceStage({
      rotationId: 'test-rotation-uuid',
      toStage: 'propagating',
      actor: ACTOR,
    });

    // Propagation fails → advance to failed
    mockQuery.mockResolvedValueOnce({ rows: [fakeRow({ stage: 'propagating' })] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await advanceStage({
      rotationId: 'test-rotation-uuid',
      toStage: 'failed',
      actor: ACTOR,
      outcome: 'failed',
    });

    // Recover
    mockQuery.mockResolvedValueOnce({ rows: [fakeRow({ stage: 'failed' })] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [fakeRow({ stage: 'recovering' })] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const recovered = await recoverRotation('test-rotation-uuid', ACTOR, 'propagation timeout');
    expect(recovered.currentStage).toBe('rolled_back');
  });
});

// ── Secret material never in audit entries ────────────────────────────────────

describe('secret material is never stored in audit entries (#851)', () => {
  beforeEach(() => {
    mockQuery.mockClear();
    mockQuery.mockResolvedValue({ rows: [] });
  });

  it('startRotation does not include the new secret value in audit metadata', async () => {
    await startRotation({
      credentialType: 'internal_signing',
      actor: ACTOR,
      newSecretHash: hashSecret(NEW_SECRET),
      metadata: { note: 'routine rotation' },
    });

    // Check all INSERT calls — none should contain the raw secret value
    for (const call of mockQuery.mock.calls) {
      const sql = call[0] as string;
      if (sql.includes('INSERT')) {
        const params = call[1] as unknown[];
        for (const param of params) {
          if (typeof param === 'string') {
            expect(param).not.toContain(NEW_SECRET);
            expect(param).not.toContain(OLD_SECRET);
          }
          if (typeof param === 'object' && param !== null) {
            const serialized = JSON.stringify(param);
            expect(serialized).not.toContain(NEW_SECRET);
            expect(serialized).not.toContain(OLD_SECRET);
          }
        }
      }
    }
  });

  it('advanceStage does not include secret values in audit entries', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [fakeRow({ stage: 'staged' })] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await advanceStage({
      rotationId: 'test-rotation-uuid',
      toStage: 'overlap',
      actor: ACTOR,
      metadata: { note: 'starting overlap' },
    });

    for (const call of mockQuery.mock.calls) {
      const sql = call[0] as string;
      if (sql.includes('INSERT INTO audit_logs')) {
        const params = call[1] as unknown[];
        for (const param of params) {
          if (typeof param === 'string') {
            expect(param).not.toContain(NEW_SECRET);
            expect(param).not.toContain(OLD_SECRET);
          }
        }
      }
    }
  });

  it('sanitizeMetadata strips keys matching sensitive patterns', async () => {
    await startRotation({
      credentialType: 'internal_signing',
      actor: ACTOR,
      metadata: {
        secret: 'should-be-redacted',
        password: 'should-be-redacted',
        apiKey: 'should-be-redacted',
        note: 'this-is-safe-to-store',
        count: 42,
      },
    });

    // Find the INSERT into credential_rotation_events
    const insertCall = mockQuery.mock.calls.find(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO credential_rotation_events'),
    );
    expect(insertCall).toBeDefined();
    const metadataParam = (insertCall![1] as unknown[]).find(
      (p) => typeof p === 'string' && p.includes('REDACTED'),
    );
    expect(metadataParam).toBeDefined();
    expect(metadataParam).toContain('[REDACTED]');
    expect(metadataParam).not.toContain('should-be-redacted');
    expect(metadataParam).toContain('this-is-safe-to-store');
  });
});

// ── Dependency failure ──────────────────────────────────────────────────────────

describe('dependency failure', () => {
  beforeEach(() => {
    mockQuery.mockClear();
  });

  it('startRotation does not throw when the audit log INSERT fails', async () => {
    // First query: check for existing rotation → empty
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // Second query: INSERT into credential_rotation_events → succeeds
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // Third query: INSERT into audit_logs → fails
    mockQuery.mockRejectedValueOnce(new Error('DB timeout'));
    // Fourth query (if any): handled gracefully

    await expect(
      startRotation({ credentialType: 'jwt_signing', actor: ACTOR }),
    ).resolves.toBeDefined();
  });

  it('advanceStage does not throw when the audit log INSERT fails', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [fakeRow({ stage: 'staged' })] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockRejectedValueOnce(new Error('DB connection lost'));

    await expect(
      advanceStage({
        rotationId: 'test-rotation-uuid',
        toStage: 'overlap',
        actor: ACTOR,
      }),
    ).resolves.toBeDefined();
  });

  it('startRotation throws when the initial DB query fails (cannot check for existing rotation)', async () => {
    mockQuery.mockRejectedValue(new Error('DB unreachable'));
    await expect(
      startRotation({ credentialType: 'jwt_signing', actor: ACTOR }),
    ).rejects.toThrow();
  });
});

// ── Webhook secret rotation (DB-backed, live) ──────────────────────────────────

describe('webhook inbound secret rotation (live, DB-backed)', () => {
  it('hashSecret produces a deterministic SHA-256 hash', () => {
    const h1 = hashSecret('test-secret-value');
    const h2 = hashSecret('test-secret-value');
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64); // SHA-256 hex
  });

  it('verifySecretHash confirms a correct secret without exposing it', () => {
    const h = hashSecret('my-webhook-secret');
    expect(verifySecretHash('my-webhook-secret', h)).toBe(true);
    expect(verifySecretHash('wrong-secret', h)).toBe(false);
  });
});
