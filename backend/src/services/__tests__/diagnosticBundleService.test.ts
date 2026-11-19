import { describe, it, expect, beforeEach, jest } from '@jest/globals';

type DiagnosticBundleServiceModule = typeof import('../diagnosticBundleService');

interface MockCheckpointStore {
  getCheckpoint: jest.Mock;
  listCheckpoints: jest.Mock;
}

interface MockRequestLogStore {
  getRequestLog: jest.Mock;
  listRequestLogs: jest.Mock;
}

interface MockTraceStore {
  getTrace: jest.Mock;
  listTraces: jest.Mock;
}

interface MockStateStore {
  getState: jest.Mock;
  listStates: jest.Mock;
}

interface MockClock {
  now: jest.Mock;
}

const INCIDENT_ID = 'incident-867-0001';
const ACTOR_ID = 'operator-42';
const TENANT_ID = 'tenant-financial-01';

function buildCheckpointStore(): MockCheckpointStore {
  return {
    getCheckpoint: jest.fn(async () => ({
      checkpointId: 'chk-1',
      incidentId: INCIDENT_ID,
      createdAt: '2024-05-01T10:00:00.000Z',
      payload: { balance: '100.00', currency: 'USD' },
    })),
    listCheckpoints: jest.fn(async () => [
      { checkpointId: 'chk-1', incidentId: INCIDENT_ID, createdAt: '2024-05-01T10:00:00.000Z' },
      { checkpointId: 'chk-2', incidentId: INCIDENT_ID, createdAt: '2024-05-01T10:05:00.000Z' },
    ]),
  };
}

function buildRequestLogStore(): MockRequestLogStore {
  return {
    getRequestLog: jest.fn(async () => ({
      requestId: 'req-1',
      incidentId: INCIDENT_ID,
      headers: { authorization: 'Bearer secret-token', 'x-api-key': 'super-secret' },
      body: { accountId: 'acct-1', amount: '100.00', currency: 'USD', ssn: '123-45-6789' },
    })),
    listRequestLogs: jest.fn(async () => [
      { requestId: 'req-1', incidentId: INCIDENT_ID },
      { requestId: 'req-2', incidentId: INCIDENT_ID },
    ]),
  };
}

function buildTraceStore(): MockTraceStore {
  return {
    getTrace: jest.fn(async () => ({
      traceId: 'trace-1',
      incidentId: INCIDENT_ID,
      spans: [{ spanId: 'span-1', name: 'transfer', attributes: { token: 'secret' } }],
    })),
    listTraces: jest.fn(async () => [{ traceId: 'trace-1', incidentId: INCIDENT_ID }]),
  };
}

function buildStateStore(): MockStateStore {
  return {
    getState: jest.fn(async () => ({
      stateId: 'state-1',
      incidentId: INCIDENT_ID,
      snapshot: { balance: '100.00', currency: 'USD', accountNumber: '000123456789' },
    })),
    listStates: jest.fn(async () => [{ stateId: 'state-1', incidentId: INCIDENT_ID }]),
  };
}

function buildClock(iso: string): MockClock {
  return { now: jest.fn(() => new Date(iso)) };
}

describe('diagnosticBundleService', () => {
  let service: DiagnosticBundleServiceModule;
  let checkpointStore: MockCheckpointStore;
  let requestLogStore: MockRequestLogStore;
  let traceStore: MockTraceStore;
  let stateStore: MockStateStore;
  let clock: MockClock;

  beforeEach(async () => {
    jest.resetModules();
    checkpointStore = buildCheckpointStore();
    requestLogStore = buildRequestLogStore();
    traceStore = buildTraceStore();
    stateStore = buildStateStore();
    clock = buildClock('2024-05-01T10:10:00.000Z');

    service = await import('../diagnosticBundleService');
  });

  function createService(overrides: Record<string, unknown> = {}) {
    return service.createDiagnosticBundleService({
      checkpointStore,
      requestLogStore,
      traceStore,
      stateStore,
      clock,
      maxBundleBytes: 64 * 1024,
      bundleTtlMs: 60 * 60 * 1000,
      ...overrides,
    } as any);
  }

  describe('successful bundle creation with redaction', () => {
    it('creates a bundle with bounded references and redacts sensitive fields by default', async () => {
      const svc = createService();

      const result = await svc.createBundle({
        incidentId: INCIDENT_ID,
        actorId: ACTOR_ID,
        tenantId: TENANT_ID,
        authorization: { canCreateBundle: true },
      });

      expect(result.status).toBe('created');
      expect(result.bundle.incidentId).toBe(INCIDENT_ID);
      expect(result.bundle.createdBy).toBe(ACTOR_ID);
      expect(result.bundle.redactionApplied).toBe(true);

      const serialized = JSON.stringify(result.bundle);
      expect(serialized).not.toContain('secret-token');
      expect(serialized).not.toContain('super-secret');
      expect(serialized).not.toContain('123-45-6789');
      expect(serialized).not.toContain('000123456789');

      expect(result.bundle.references.checkpoints.length).toBeGreaterThan(0);
      expect(result.bundle.references.requests.length).toBeGreaterThan(0);
      expect(result.bundle.references.traces.length).toBeGreaterThan(0);
      expect(result.bundle.references.states.length).toBeGreaterThan(0);

      expect(result.bundle.expiresAt).toBeDefined();
      expect(new Date(result.bundle.expiresAt).getTime()).toBeGreaterThan(
        clock.now().getTime(),
      );
    });

    it('is reproducible from the incident ID alone', async () => {
      const svc = createService();

      const first = await svc.createBundle({
        incidentId: INCIDENT_ID,
        actorId: ACTOR_ID,
        tenantId: TENANT_ID,
        authorization: { canCreateBundle: true },
      });
      const second = await svc.createBundle({
        incidentId: INCIDENT_ID,
        actorId: ACTOR_ID,
        tenantId: TENANT_ID,
        authorization: { canCreateBundle: true },
      });

      expect(second.bundle.bundleId).toBe(first.bundle.bundleId);
      expect(second.bundle.references).toEqual(first.bundle.references);
    });
  });

  describe('oversized bundle boundary', () => {
    it('rejects a bundle that exceeds the configured maximum size', async () => {
      const svc = createService({ maxBundleBytes: 16 });

      const result = await svc.createBundle({
        incidentId: INCIDENT_ID,
        actorId: ACTOR_ID,
        tenantId: TENANT_ID,
        authorization: { canCreateBundle: true },
      });

      expect(result.status).toBe('rejected');
      expect(result.reason).toBe('bundle_too_large');
      expect(result.bundle).toBeUndefined();
    });
  });

  describe('expired bundle boundary', () => {
    it('rejects retrieval of an expired bundle', async () => {
      const svc = createService({ bundleTtlMs: 1000 });

      const created = await svc.createBundle({
        incidentId: INCIDENT_ID,
        actorId: ACTOR_ID,
        tenantId: TENANT_ID,
        authorization: { canCreateBundle: true },
      });
      expect(created.status).toBe('created');

      clock.now.mockReturnValue(new Date('2024-05-01T12:00:00.000Z'));

      const retrieved = await svc.getBundle({
        bundleId: created.bundle.bundleId,
        actorId: ACTOR_ID,
        tenantId: TENANT_ID,
        authorization: { canCreateBundle: true },
      });

      expect(retrieved.status).toBe('rejected');
      expect(retrieved.reason).toBe('bundle_expired');
    });

    it('rejects creation when the requested TTL is non-positive', async () => {
      const svc = createService({ bundleTtlMs: 0 });

      const result = await svc.createBundle({
        incidentId: INCIDENT_ID,
        actorId: ACTOR_ID,
        tenantId: TENANT_ID,
        authorization: { canCreateBundle: true },
      });

      expect(result.status).toBe('rejected');
      expect(result.reason).toBe('invalid_ttl');
    });
  });

  describe('idempotent repeat creation', () => {
    it('returns the same bundle for repeated identical requests', async () => {
      const svc = createService();

      const first = await svc.createBundle({
        incidentId: INCIDENT_ID,
        actorId: ACTOR_ID,
        tenantId: TENANT_ID,
        authorization: { canCreateBundle: true },
      });
      const second = await svc.createBundle({
        incidentId: INCIDENT_ID,
        actorId: ACTOR_ID,
        tenantId: TENANT_ID,
        authorization: { canCreateBundle: true },
      });

      expect(first.status).toBe('created');
      expect(second.status).toBe('created');
      expect(second.bundle.bundleId).toBe(first.bundle.bundleId);
      expect(second.idempotentReplay).toBe(true);
    });

    it('does not duplicate side effects on idempotent replay', async () => {
      const svc = createService();

      await svc.createBundle({
        incidentId: INCIDENT_ID,
        actorId: ACTOR_ID,
        tenantId: TENANT_ID,
        authorization: { canCreateBundle: true },
      });
      const callsAfterFirst = checkpointStore.listCheckpoints.mock.calls.length;

      await svc.createBundle({
        incidentId: INCIDENT_ID,
        actorId: ACTOR_ID,
        tenantId: TENANT_ID,
        authorization: { canCreateBundle: true },
      });

      expect(checkpointStore.listCheckpoints.mock.calls.length).toBe(callsAfterFirst);
    });
  });

  describe('access-control denial', () => {
    it('denies creation when the actor is not authorized', async () => {
      const svc = createService();

      const result = await svc.createBundle({
        incidentId: INCIDENT_ID,
        actorId: ACTOR_ID,
        tenantId: TENANT_ID,
        authorization: { canCreateBundle: false },
      });

      expect(result.status).toBe('rejected');
      expect(result.reason).toBe('forbidden');
      expect(result.bundle).toBeUndefined();
    });

    it('denies retrieval across tenants', async () => {
      const svc = createService();

      const created = await svc.createBundle({
        incidentId: INCIDENT_ID,
        actorId: ACTOR_ID,
        tenantId: TENANT_ID,
        authorization: { canCreateBundle: true },
      });
      expect(created.status).toBe('created');

      const retrieved = await svc.getBundle({
        bundleId: created.bundle.bundleId,
        actorId: ACTOR_ID,
        tenantId: 'tenant-other',
        authorization: { canCreateBundle: true },
      });

      expect(retrieved.status).toBe('rejected');
      expect(retrieved.reason).toBe('forbidden');
    });
  });

  describe('missing checkpoint-store dependency failure', () => {
    it('fails cleanly when the checkpoint store is unavailable', async () => {
      const svc = createService({ checkpointStore: undefined });

      const result = await svc.createBundle({
        incidentId: INCIDENT_ID,
        actorId: ACTOR_ID,
        tenantId: TENANT_ID,
        authorization: { canCreateBundle: true },
      });

      expect(result.status).toBe('rejected');
      expect(result.reason).toBe('dependency_unavailable');
      expect(result.bundle).toBeUndefined();
    });

    it('fails cleanly when the checkpoint store throws', async () => {
      checkpointStore.listCheckpoints.mockRejectedValue(new Error('store down'));
      const svc = createService();

      const result = await svc.createBundle({
        incidentId: INCIDENT_ID,
        actorId: ACTOR_ID,
        tenantId: TENANT_ID,
        authorization: { canCreateBundle: true },
      });

      expect(result.status).toBe('rejected');
      expect(result.reason).toBe('dependency_unavailable');
      expect(result.bundle).toBeUndefined();
    });
  });
});