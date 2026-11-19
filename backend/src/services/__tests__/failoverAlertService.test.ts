import {
  FailoverAlertService,
  AlertSeverity,
  AlertOwner,
  NotificationProvider,
  NotificationResult,
  DrillConfig,
  DrillResult,
  AlertError,
  AlertErrorCode,
} from '../failoverAlertService';

/**
 * In-memory notification provider used to exercise delivery, retries,
 * idempotency and dependency-failure behaviour without touching the network.
 */
class InMemoryNotificationProvider implements NotificationProvider {
  public sent: Array<{ alertId: string; channel: string; recipient: string }> = [];
  public shouldFail = false;
  public failCount = 0;
  public failUntilAttempt: number | null = null;
  private attempts = 0;

  async send(alertId: string, channel: string, recipient: string): Promise<NotificationResult> {
    this.attempts += 1;
    if (this.shouldFail) {
      throw new Error('notification provider unavailable');
    }
    if (this.failUntilAttempt !== null && this.attempts < this.failUntilAttempt) {
      throw new Error('transient notification provider failure');
    }
    this.sent.push({ alertId, channel, recipient });
    return { delivered: true, providerMessageId: `msg-${this.sent.length}` };
  }

  reset(): void {
    this.sent = [];
    this.shouldFail = false;
    this.failCount = 0;
    this.failUntilAttempt = null;
    this.attempts = 0;
  }
}

const validOwners: AlertOwner[] = [
  {
    id: 'owner-finops',
    team: 'finops-oncall',
    escalationRoute: ['pagerduty:finops-primary', 'pagerduty:finops-secondary', 'slack:#finops-escalation'],
    runbookUrl: 'https://runbooks.example.com/finops/slo-breach',
  },
  {
    id: 'owner-payments',
    team: 'payments-oncall',
    escalationRoute: ['pagerduty:payments-primary', 'pagerduty:payments-secondary'],
    runbookUrl: 'https://runbooks.example.com/payments/slo-breach',
  },
];

const validDrillConfig: DrillConfig = {
  drillId: 'drill-2024-06-01',
  scheduledAt: '2024-06-01T10:00:00.000Z',
  requestedBy: 'user-ops-lead',
  actorRoles: ['sre', 'oncall-manager'],
  alerts: [
    {
      alertId: 'alert-settlement-latency',
      sloName: 'settlement_latency_p99',
      severity: AlertSeverity.CRITICAL,
      ownerId: 'owner-payments',
      thresholdBreached: true,
    },
    {
      alertId: 'alert-reconciliation-lag',
      sloName: 'reconciliation_lag',
      severity: AlertSeverity.CRITICAL,
      ownerId: 'owner-finops',
      thresholdBreached: true,
    },
  ],
};

describe('FailoverAlertService', () => {
  let provider: InMemoryNotificationProvider;
  let service: FailoverAlertService;

  beforeEach(() => {
    provider = new InMemoryNotificationProvider();
    service = new FailoverAlertService({
      notificationProvider: provider,
      owners: validOwners,
      clock: () => new Date('2024-06-01T10:00:00.000Z'),
    });
  });

  afterEach(() => {
    provider.reset();
  });

  describe('alert ownership mapping', () => {
    it('maps a critical SLO alert to owner, severity, runbook and escalation route', () => {
      const mapping = service.resolveAlertOwnership({
        alertId: 'alert-settlement-latency',
        sloName: 'settlement_latency_p99',
        severity: AlertSeverity.CRITICAL,
        ownerId: 'owner-payments',
      });

      expect(mapping.alertId).toBe('alert-settlement-latency');
      expect(mapping.severity).toBe(AlertSeverity.CRITICAL);
      expect(mapping.owner.id).toBe('owner-payments');
      expect(mapping.owner.team).toBe('payments-oncall');
      expect(mapping.runbookUrl).toBe('https://runbooks.example.com/payments/slo-breach');
      expect(mapping.escalationRoute).toEqual([
        'pagerduty:payments-primary',
        'pagerduty:payments-secondary',
      ]);
    });

    it('rejects an unknown owner with an explicit error and no side effects', () => {
      expect(() =>
        service.resolveAlertOwnership({
          alertId: 'alert-unknown-owner',
          sloName: 'settlement_latency_p99',
          severity: AlertSeverity.CRITICAL,
          ownerId: 'owner-does-not-exist',
        }),
      ).toThrow(AlertError);

      try {
        service.resolveAlertOwnership({
          alertId: 'alert-unknown-owner',
          sloName: 'settlement_latency_p99',
          severity: AlertSeverity.CRITICAL,
          ownerId: 'owner-does-not-exist',
        });
      } catch (err) {
        expect((err as AlertError).code).toBe(AlertErrorCode.UNKNOWN_OWNER);
      }
      expect(provider.sent).toHaveLength(0);
    });

    it('rejects an unsupported severity value', () => {
      expect(() =>
        service.resolveAlertOwnership({
          alertId: 'alert-bad-severity',
          sloName: 'settlement_latency_p99',
          severity: 'SUPER_CRITICAL' as AlertSeverity,
          ownerId: 'owner-payments',
        }),
      ).toThrow(AlertError);

      try {
        service.resolveAlertOwnership({
          alertId: 'alert-bad-severity',
          sloName: 'settlement_latency_p99',
          severity: 'SUPER_CRITICAL' as AlertSeverity,
          ownerId: 'owner-payments',
        });
      } catch (err) {
        expect((err as AlertError).code).toBe(AlertErrorCode.INVALID_SEVERITY);
      }
    });

    it('rejects an owner that has no escalation route configured', () => {
      const serviceWithBadOwner = new FailoverAlertService({
        notificationProvider: provider,
        owners: [
          {
            id: 'owner-no-route',
            team: 'orphan-team',
            escalationRoute: [],
            runbookUrl: 'https://runbooks.example.com/orphan',
          },
        ],
        clock: () => new Date('2024-06-01T10:00:00.000Z'),
      });

      try {
        serviceWithBadOwner.resolveAlertOwnership({
          alertId: 'alert-no-route',
          sloName: 'settlement_latency_p99',
          severity: AlertSeverity.CRITICAL,
          ownerId: 'owner-no-route',
        });
        fail('expected resolveAlertOwnership to throw');
      } catch (err) {
        expect((err as AlertError).code).toBe(AlertErrorCode.MISSING_ESCALATION_ROUTE);
      }
    });
  });

  describe('drill execution - success path', () => {
    it('delivers notifications to every escalation step and records acknowledgement/recovery', async () => {
      const result: DrillResult = await service.runDrill(validDrillConfig);

      expect(result.drillId).toBe('drill-2024-06-01');
      expect(result.status).toBe('completed');
      expect(result.alerts).toHaveLength(2);

      const settlement = result.alerts.find((a) => a.alertId === 'alert-settlement-latency');
      expect(settlement).toBeDefined();
      expect(settlement!.ownerId).toBe('owner-payments');
      expect(settlement!.notificationsDelivered).toBeGreaterThan(0);
      expect(settlement!.acknowledged).toBe(true);
      expect(settlement!.recovered).toBe(true);
      expect(settlement!.acknowledgedAt).toBeDefined();
      expect(settlement!.recoveredAt).toBeDefined();

      // Both escalation steps for payments should have been notified.
      const paymentsNotifications = provider.sent.filter((s) =>
        s.recipient.startsWith('pagerduty:payments'),
      );
      expect(paymentsNotifications.length).toBe(2);

      const finopsNotifications = provider.sent.filter((s) =>
        s.recipient.startsWith('pagerduty:finops'),
      );
      expect(finopsNotifications.length).toBeGreaterThanOrEqual(2);
    });

    it('records drill audit metadata (requestedBy, scheduledAt, executedAt)', async () => {
      const result = await service.runDrill(validDrillConfig);
      expect(result.requestedBy).toBe('user-ops-lead');
      expect(result.scheduledAt).toBe('2024-06-01T10:00:00.000Z');
      expect(result.executedAt).toBe('2024-06-01T10:00:00.000Z');
    });
  });

  describe('drill execution - validation boundaries', () => {
    it('rejects a drill with an invalid severity without partial side effects', async () => {
      const badConfig: DrillConfig = {
        ...validDrillConfig,
        drillId: 'drill-bad-severity',
        alerts: [
          {
            alertId: 'alert-bad',
            sloName: 'settlement_latency_p99',
            severity: 'NOT_A_SEVERITY' as AlertSeverity,
            ownerId: 'owner-payments',
            thresholdBreached: true,
          },
        ],
      };

      await expect(service.runDrill(badConfig)).rejects.toMatchObject({
        code: AlertErrorCode.INVALID_SEVERITY,
      });
      expect(provider.sent).toHaveLength(0);
    });

    it('rejects a drill referencing an unknown owner without partial side effects', async () => {
      const badConfig: DrillConfig = {
        ...validDrillConfig,
        drillId: 'drill-bad-owner',
        alerts: [
          {
            alertId: 'alert-bad-owner',
            sloName: 'settlement_latency_p99',
            severity: AlertSeverity.CRITICAL,
            ownerId: 'owner-missing',
            thresholdBreached: true,
          },
        ],
      };

      await expect(service.runDrill(badConfig)).rejects.toMatchObject({
        code: AlertErrorCode.UNKNOWN_OWNER,
      });
      expect(provider.sent).toHaveLength(0);
    });

    it('rejects a drill with no alerts', async () => {
      const emptyConfig: DrillConfig = {
        ...validDrillConfig,
        drillId: 'drill-empty',
        alerts: [],
      };

      await expect(service.runDrill(emptyConfig)).rejects.toMatchObject({
        code: AlertErrorCode.EMPTY_DRILL,
      });
      expect(provider.sent).toHaveLength(0);
    });
  });

  describe('drill execution - idempotency', () => {
    it('returns the same result for a duplicate drillId without re-sending notifications', async () => {
      const first = await service.runDrill(validDrillConfig);
      const sentAfterFirst = provider.sent.length;

      const second = await service.runDrill(validDrillConfig);

      expect(second).toEqual(first);
      expect(provider.sent.length).toBe(sentAfterFirst);
    });

    it('rejects a duplicate drillId with a conflicting payload', async () => {
      await service.runDrill(validDrillConfig);

      const conflicting: DrillConfig = {
        ...validDrillConfig,
        alerts: [
          {
            alertId: 'alert-different',
            sloName: 'settlement_latency_p99',
            severity: AlertSeverity.CRITICAL,
            ownerId: 'owner-payments',
            thresholdBreached: true,
          },
        ],
      };

      await expect(service.runDrill(conflicting)).rejects.toMatchObject({
        code: AlertErrorCode.DRILL_CONFLICT,
      });
    });
  });

  describe('drill execution - RBAC', () => {
    it('denies drill execution when the actor lacks the required role', async () => {
      const unauthorized: DrillConfig = {
        ...validDrillConfig,
        drillId: 'drill-unauthorized',
        actorRoles: ['viewer'],
      };

      await expect(service.runDrill(unauthorized)).rejects.toMatchObject({
        code: AlertErrorCode.FORBIDDEN,
      });
      expect(provider.sent).toHaveLength(0);
    });

    it('denies drill execution when the actor has no roles', async () => {
      const unauthorized: DrillConfig = {
        ...validDrillConfig,
        drillId: 'drill-no-roles',
        actorRoles: [],
      };

      await expect(service.runDrill(unauthorized)).rejects.toMatchObject({
        code: AlertErrorCode.FORBIDDEN,
      });
      expect(provider.sent).toHaveLength(0);
    });
  });

  describe('drill execution - dependency failure', () => {
    it('fails the drill when the notification provider is down and records no acknowledgement', async () => {
      provider.shouldFail = true;

      await expect(service.runDrill(validDrillConfig)).rejects.toMatchObject({
        code: AlertErrorCode.NOTIFICATION_FAILED,
      });

      // No partial financial side effects: nothing was delivered.
      expect(provider.sent).toHaveLength(0);

      // A subsequent retry after the provider recovers should succeed.
      provider.shouldFail = false;
      const retry = await service.runDrill(validDrillConfig);
      expect(retry.status).toBe('completed');
      expect(provider.sent.length).toBeGreaterThan(0);
    });

    it('retries transient provider failures before giving up', async () => {
      provider.failUntilAttempt = 2;

      const result = await service.runDrill(validDrillConfig);
      expect(result.status).toBe('completed');
      expect(provider.sent.length).toBeGreaterThan(0);
    });
  });
});