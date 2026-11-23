/**
 * Test suite for the database restore consistency checker (issue #859).
 *
 * Coverage:
 *   A. Migration state checks
 *      A1. passes when pgmigrations exists and all disk files are applied
 *      A2. fails (critical) when pgmigrations table is absent
 *      A3. fails (critical) when a migration file on disk is not in pgmigrations
 *      A4. returns informational count when all migrations are applied
 *
 *   B. Table presence checks
 *      B1. passes when all required tables exist
 *      B2. fails (critical) listing missing tables when any are absent
 *
 *   C. Row count checks
 *      C1. passes when non-empty tables have rows
 *      C2. warns when a required non-empty table is empty
 *
 *   D. Ledger checkpoint checks
 *      D1. fails (critical) when no verified checkpoints exist
 *      D2. passes and measures RPO window from latest checkpoint
 *      D3. warns when RPO window exceeds the target
 *      D4. warns when suspect gaps exist
 *
 *   E. Financial invariant checks
 *      E1. fails (critical) on fractional stroop amounts in contract_events
 *      E2. fails (critical) when reconciliation_discrepancies guard trigger is absent
 *      E3. fails (critical) on duplicate intent_keys in cross_contract_reconciliation
 *      E4. fails (critical) on broken FK in orphaned_tx_reconciliation
 *      E5. fails (critical) when privileged_action_requests has approver = initiator
 *      E6. passes all invariant checks when data is clean
 *
 *   F. Full run
 *      F1. passed=true when all checks pass
 *      F2. passed=false when any critical check fails
 *      F3. report includes rpoWindowMs, migrationCount, criticalFailures, warnings
 *
 *   G. Report builder (scripts/restore-rehearsal.mjs helpers)
 *      G1. buildReport marks rto.breached=true when duration exceeds target
 *      G2. buildReport marks rpo.breached=true when rpoWindowMs exceeds target
 *      G3. buildReport passed=false when any breach occurs
 *      G4. buildReport passed=true when all within targets
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// ── Mock the pg client ────────────────────────────────────────────────────

type Row = Record<string, unknown>;

class MockClient {
  public calls: { sql: string; result: Row[] }[] = [];
  private responses: Array<Row[]> = [];

  queue(...rows: Row[][]): void {
    this.responses.push(...rows);
  }

  async query<T = Row>(sql: string): Promise<{ rows: T[]; rowCount: number }> {
    const rows = (this.responses.shift() ?? []) as T[];
    this.calls.push({ sql, result: rows as Row[] });
    return { rows, rowCount: rows.length };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

const NOW = new Date();
const FIVE_MIN_AGO = new Date(NOW.getTime() - 5 * 60_000);
const TEN_MIN_AGO = new Date(NOW.getTime() - 10 * 60_000);

// ── Import the checker after creating a mock ─────────────────────────────
// We import with a fake pg client rather than mocking the module, because
// RestoreConsistencyChecker accepts an injected client.

const {
  RestoreConsistencyChecker,
  REQUIRED_TABLES,
  NON_EMPTY_TABLES,
} = await import('../services/restoreConsistencyChecker.js');

// ── A. Migration state ────────────────────────────────────────────────────

describe('A. Migration state checks', () => {
  let client: MockClient;

  beforeEach(() => {
    client = new MockClient();
  });

  it('A1. passes when pgmigrations exists and all disk migrations are applied', async () => {
    client.queue(
      [{ exists: true }],                        // table exists
      [{ count: '3' }],                           // applied count
      [                                           // applied names
        { name: '1771691269865_initial-schema' },
        { name: '1771691269866_loan-events-schema' },
        { name: '1772000000000_webhook-subscriptions' },
      ],
    );
    const checker = new RestoreConsistencyChecker(client as never, '/nonexistent-path');
    // Override disk scan to return the same 3 files
    const spy = jest.spyOn(await import('node:fs'), 'readdirSync').mockReturnValue([
      '1771691269865_initial-schema.js',
      '1771691269866_loan-events-schema.js',
      '1772000000000_webhook-subscriptions.js',
    ] as never);

    const results = await checker.checkMigrationState();
    spy.mockRestore();

    const failed = results.filter((r) => !r.passed);
    expect(failed).toHaveLength(0);
    expect(results.find((r) => r.name === 'migrations_fully_applied')?.passed).toBe(true);
  });

  it('A2. fails (critical) when pgmigrations table is absent', async () => {
    client.queue([{ exists: false }]);
    const checker = new RestoreConsistencyChecker(client as never);
    const results = await checker.checkMigrationState();
    const failing = results.find((r) => r.name === 'migration_table_exists');
    expect(failing?.passed).toBe(false);
    expect(failing?.severity).toBe('critical');
  });

  it('A3. fails (critical) when a migration file on disk is not in pgmigrations', async () => {
    client.queue(
      [{ exists: true }],
      [{ count: '1' }],
      [{ name: '1771691269865_initial-schema' }],
    );
    const checker = new RestoreConsistencyChecker(client as never, '/nonexistent-path');
    const spy = jest.spyOn(await import('node:fs'), 'readdirSync').mockReturnValue([
      '1771691269865_initial-schema.js',
      '1809000000000_orphaned-tx-reconciliation.js', // on disk but not applied
    ] as never);

    const results = await checker.checkMigrationState();
    spy.mockRestore();

    const check = results.find((r) => r.name === 'migrations_fully_applied');
    expect(check?.passed).toBe(false);
    expect(check?.severity).toBe('critical');
    expect(String(check?.detail)).toContain('1809000000000_orphaned-tx-reconciliation');
  });

  it('A4. returns informational count when all migrations are applied', async () => {
    client.queue(
      [{ exists: true }],
      [{ count: '54' }],
      Array.from({ length: 54 }, (_, i) => ({ name: `migration_${i}` })),
    );
    const checker = new RestoreConsistencyChecker(client as never, '/nonexistent-path');
    const spy = jest.spyOn(await import('node:fs'), 'readdirSync').mockReturnValue(
      Array.from({ length: 54 }, (_, i) => `migration_${i}.js`) as never,
    );

    const results = await checker.checkMigrationState();
    spy.mockRestore();

    const count = results.find((r) => r.name === 'migration_count');
    expect(count?.value).toBe(54);
    expect(count?.passed).toBe(true);
  });
});

// ── B. Table presence ─────────────────────────────────────────────────────

describe('B. Table presence checks', () => {
  let client: MockClient;

  beforeEach(() => { client = new MockClient(); });

  it('B1. passes when all required tables exist', async () => {
    client.queue(REQUIRED_TABLES.map((t) => ({ table_name: t })));
    const checker = new RestoreConsistencyChecker(client as never);
    const results = await checker.checkTablePresence();
    expect(results[0]?.passed).toBe(true);
    expect(results[0]?.name).toBe('required_tables_present');
  });

  it('B2. fails (critical) listing missing tables', async () => {
    // Return all tables except the last two
    client.queue(REQUIRED_TABLES.slice(0, -2).map((t) => ({ table_name: t })));
    const checker = new RestoreConsistencyChecker(client as never);
    const results = await checker.checkTablePresence();
    expect(results[0]?.passed).toBe(false);
    expect(results[0]?.severity).toBe('critical');
    const missing = results[0]?.value as string[];
    expect(missing).toHaveLength(2);
    expect(missing).toContain(REQUIRED_TABLES[REQUIRED_TABLES.length - 1]);
  });
});

// ── C. Row counts ─────────────────────────────────────────────────────────

describe('C. Row count checks', () => {
  let client: MockClient;

  beforeEach(() => { client = new MockClient(); });

  it('C1. passes when non-empty tables have rows', async () => {
    // pause_state: 1 row; then financial tables: 10 rows each
    client.queue(
      [{ count: '1' }],   // pause_state
      [{ count: '100' }], // contract_events
      [{ count: '50' }],  // transaction_submissions
      [{ count: '30' }],  // remittances
      [{ count: '20' }],  // loan_history
      [{ count: '10' }],  // ledger_checkpoints
      [{ count: '5' }],   // audit_logs
    );
    const checker = new RestoreConsistencyChecker(client as never);
    const results = await checker.checkRowCounts();
    const pauseCheck = results.find((r) => r.name === 'row_count_pause_state');
    expect(pauseCheck?.passed).toBe(true);
  });

  it('C2. warns when a required non-empty table is empty', async () => {
    client.queue(
      [{ count: '0' }],  // pause_state empty
      [{ count: '0' }],  // contract_events
      [{ count: '0' }],  // transaction_submissions
      [{ count: '0' }],  // remittances
      [{ count: '0' }],  // loan_history
      [{ count: '0' }],  // ledger_checkpoints
      [{ count: '0' }],  // audit_logs
    );
    const checker = new RestoreConsistencyChecker(client as never);
    const results = await checker.checkRowCounts();
    const pauseCheck = results.find((r) => r.name === 'row_count_pause_state');
    expect(pauseCheck?.passed).toBe(false);
    expect(pauseCheck?.severity).toBe('warning');
  });
});

// ── D. Ledger checkpoint checks ───────────────────────────────────────────

describe('D. Ledger checkpoint checks', () => {
  let client: MockClient;

  beforeEach(() => { client = new MockClient(); });

  it('D1. fails (critical) when no verified checkpoints exist', async () => {
    client.queue([{ count: '0' }]);
    const checker = new RestoreConsistencyChecker(client as never);
    const { results } = await checker.checkLedgerCheckpoints();
    expect(results[0]?.passed).toBe(false);
    expect(results[0]?.severity).toBe('critical');
    expect(results[0]?.name).toBe('ledger_checkpoints_present');
  });

  it('D2. passes and measures RPO window from latest checkpoint', async () => {
    process.env.RESTORE_RPO_TARGET_MS = String(10 * 60_000); // 10 min target
    client.queue(
      [{ count: '5' }],       // verified count
      [{ count: '0' }],       // no suspect gaps
      [{ created_at: FIVE_MIN_AGO, range_end: '1000' }], // latest checkpoint 5 min ago
    );
    const checker = new RestoreConsistencyChecker(client as never);
    const { results, rpoWindowMs } = await checker.checkLedgerCheckpoints();
    delete process.env.RESTORE_RPO_TARGET_MS;

    expect(results.find((r) => r.name === 'ledger_checkpoints_present')?.passed).toBe(true);
    expect(results.find((r) => r.name === 'ledger_checkpoint_rpo')?.passed).toBe(true);
    expect(rpoWindowMs).toBeGreaterThan(0);
    expect(rpoWindowMs).toBeLessThan(10 * 60_000);
  });

  it('D3. warns when RPO window exceeds the target', async () => {
    process.env.RESTORE_RPO_TARGET_MS = String(60_000); // 1 min target
    client.queue(
      [{ count: '3' }],
      [{ count: '0' }],
      [{ created_at: TEN_MIN_AGO, range_end: '900' }], // 10 min ago — exceeds 1 min target
    );
    const checker = new RestoreConsistencyChecker(client as never);
    const { results } = await checker.checkLedgerCheckpoints();
    delete process.env.RESTORE_RPO_TARGET_MS;

    const rpoCheck = results.find((r) => r.name === 'ledger_checkpoint_rpo');
    expect(rpoCheck?.passed).toBe(false);
    expect(rpoCheck?.severity).toBe('warning');
  });

  it('D4. warns when suspect gaps exist', async () => {
    process.env.RESTORE_RPO_TARGET_MS = String(10 * 60_000);
    client.queue(
      [{ count: '5' }],
      [{ count: '2' }],       // 2 suspect gaps
      [{ created_at: FIVE_MIN_AGO, range_end: '1000' }],
    );
    const checker = new RestoreConsistencyChecker(client as never);
    const { results } = await checker.checkLedgerCheckpoints();
    delete process.env.RESTORE_RPO_TARGET_MS;

    const gapCheck = results.find((r) => r.name === 'ledger_no_suspect_gaps');
    expect(gapCheck?.passed).toBe(false);
    expect(gapCheck?.severity).toBe('warning');
  });
});

// ── E. Financial invariant checks ─────────────────────────────────────────

describe('E. Financial invariant checks', () => {
  let client: MockClient;

  beforeEach(() => { client = new MockClient(); });

  /**
   * Queue all financial invariant queries in the correct order:
   * 1. stroop integrity (contract_events)
   * 2. loan_history cols x4
   * 3. guard trigger
   * 4. duplicate intent_keys
   * 5. orphaned_tx FK
   * 6. privileged_action distinct principals
   * 7. discrepancy rule versions
   */
  function queueClean() {
    client.queue(
      [{ count: '0' }],  // no bad stroops in contract_events
      [{ count: '0' }],  // principal_amount
      [{ count: '0' }],  // principal_paid
      [{ count: '0' }],  // interest_paid
      [{ count: '0' }],  // accrued_interest
      [{ trigger_name: 'reconciliation_discrepancies_guard' }], // trigger present
      [{ count: '0' }],  // no duplicate intent_keys
      [{ count: '0' }],  // no broken FKs
      [{ count: '0' }],  // no bad principals
      [],                // no discrepancy rows (empty)
    );
  }

  it('E1. fails (critical) on fractional stroop amounts in contract_events', async () => {
    client.queue(
      [{ count: '3' }],  // 3 fractional rows
      [{ count: '0' }], [{ count: '0' }], [{ count: '0' }], [{ count: '0' }],
      [{ trigger_name: 'reconciliation_discrepancies_guard' }],
      [{ count: '0' }], [{ count: '0' }], [{ count: '0' }], [],
    );
    const checker = new RestoreConsistencyChecker(client as never);
    const results = await checker.checkFinancialInvariants();
    const check = results.find((r) => r.name === 'stroop_integrity_contract_events');
    expect(check?.passed).toBe(false);
    expect(check?.severity).toBe('critical');
    expect(check?.value).toBe(3);
  });

  it('E2. fails (critical) when reconciliation guard trigger is absent', async () => {
    client.queue(
      [{ count: '0' }],
      [{ count: '0' }], [{ count: '0' }], [{ count: '0' }], [{ count: '0' }],
      [],  // no trigger rows → trigger absent
      [{ count: '0' }], [{ count: '0' }], [{ count: '0' }], [],
    );
    const checker = new RestoreConsistencyChecker(client as never);
    const results = await checker.checkFinancialInvariants();
    const check = results.find((r) => r.name === 'reconciliation_guard_trigger');
    expect(check?.passed).toBe(false);
    expect(check?.severity).toBe('critical');
  });

  it('E3. fails (critical) on duplicate intent_keys', async () => {
    client.queue(
      [{ count: '0' }],
      [{ count: '0' }], [{ count: '0' }], [{ count: '0' }], [{ count: '0' }],
      [{ trigger_name: 'reconciliation_discrepancies_guard' }],
      [{ count: '2' }],  // 2 duplicate intent_keys
      [{ count: '0' }], [{ count: '0' }], [],
    );
    const checker = new RestoreConsistencyChecker(client as never);
    const results = await checker.checkFinancialInvariants();
    const check = results.find((r) => r.name === 'cross_contract_intent_key_unique');
    expect(check?.passed).toBe(false);
    expect(check?.severity).toBe('critical');
  });

  it('E4. fails (critical) on broken FK in orphaned_tx_reconciliation', async () => {
    client.queue(
      [{ count: '0' }],
      [{ count: '0' }], [{ count: '0' }], [{ count: '0' }], [{ count: '0' }],
      [{ trigger_name: 'reconciliation_discrepancies_guard' }],
      [{ count: '0' }],
      [{ count: '1' }],  // 1 broken FK
      [{ count: '0' }], [],
    );
    const checker = new RestoreConsistencyChecker(client as never);
    const results = await checker.checkFinancialInvariants();
    const check = results.find((r) => r.name === 'orphaned_tx_fk_integrity');
    expect(check?.passed).toBe(false);
    expect(check?.severity).toBe('critical');
  });

  it('E5. fails (critical) when privileged_action_requests has approver = initiator', async () => {
    client.queue(
      [{ count: '0' }],
      [{ count: '0' }], [{ count: '0' }], [{ count: '0' }], [{ count: '0' }],
      [{ trigger_name: 'reconciliation_discrepancies_guard' }],
      [{ count: '0' }], [{ count: '0' }],
      [{ count: '1' }],  // 1 bad row
      [],
    );
    const checker = new RestoreConsistencyChecker(client as never);
    const results = await checker.checkFinancialInvariants();
    const check = results.find((r) => r.name === 'privileged_action_distinct_principals');
    expect(check?.passed).toBe(false);
    expect(check?.severity).toBe('critical');
  });

  it('E6. passes all invariant checks when data is clean', async () => {
    queueClean();
    const checker = new RestoreConsistencyChecker(client as never);
    const results = await checker.checkFinancialInvariants();
    const failed = results.filter((r) => !r.passed);
    expect(failed).toHaveLength(0);
  });
});

// ── F. Full run ───────────────────────────────────────────────────────────

describe('F. Full run', () => {
  let client: MockClient;

  beforeEach(() => { client = new MockClient(); });

  it('F1. passed=true when all checks pass', async () => {
    // Migration checks
    client.queue(
      [{ exists: true }],
      [{ count: '1' }],
      [{ name: 'mig_1' }],
    );
    // Table presence
    client.queue(REQUIRED_TABLES.map((t) => ({ table_name: t })));
    // Row counts: pause_state + 6 financial
    client.queue(
      [{ count: '1' }],
      [{ count: '10' }], [{ count: '5' }], [{ count: '3' }], [{ count: '2' }],
      [{ count: '1' }], [{ count: '8' }],
    );
    // Ledger checkpoints
    process.env.RESTORE_RPO_TARGET_MS = String(10 * 60_000);
    client.queue(
      [{ count: '3' }],
      [{ count: '0' }],
      [{ created_at: FIVE_MIN_AGO, range_end: '900' }],
    );
    // Financial invariants (all clean)
    client.queue(
      [{ count: '0' }],
      [{ count: '0' }], [{ count: '0' }], [{ count: '0' }], [{ count: '0' }],
      [{ trigger_name: 'reconciliation_discrepancies_guard' }],
      [{ count: '0' }], [{ count: '0' }], [{ count: '0' }], [],
    );

    const spy = jest.spyOn(await import('node:fs'), 'readdirSync').mockReturnValue(
      ['mig_1.js'] as never,
    );
    const checker = new RestoreConsistencyChecker(client as never, '/fake');
    const report = await checker.run();
    spy.mockRestore();
    delete process.env.RESTORE_RPO_TARGET_MS;

    expect(report.passed).toBe(true);
    expect(report.criticalFailures).toBe(0);
  });

  it('F2. passed=false when a critical check fails', async () => {
    // Migration: table missing → critical failure
    client.queue([{ exists: false }]);
    // Table presence
    client.queue(REQUIRED_TABLES.map((t) => ({ table_name: t })));
    // Row counts
    client.queue([{ count: '1' }], ...Array(6).fill([{ count: '0' }]));
    // Ledger checkpoints: none
    client.queue([{ count: '0' }]);
    // Financial: clean
    client.queue(
      [{ count: '0' }],
      [{ count: '0' }], [{ count: '0' }], [{ count: '0' }], [{ count: '0' }],
      [{ trigger_name: 'reconciliation_discrepancies_guard' }],
      [{ count: '0' }], [{ count: '0' }], [{ count: '0' }], [],
    );

    const checker = new RestoreConsistencyChecker(client as never);
    const report = await checker.run();
    expect(report.passed).toBe(false);
    expect(report.criticalFailures).toBeGreaterThan(0);
  });

  it('F3. report includes rpoWindowMs, migrationCount, criticalFailures, warnings', async () => {
    client.queue(
      [{ exists: true }],
      [{ count: '10' }],
      Array.from({ length: 10 }, (_, i) => ({ name: `m${i}` })),
    );
    client.queue(REQUIRED_TABLES.map((t) => ({ table_name: t })));
    client.queue(
      [{ count: '1' }],
      [{ count: '5' }], [{ count: '5' }], [{ count: '5' }], [{ count: '5' }],
      [{ count: '5' }], [{ count: '5' }],
    );
    process.env.RESTORE_RPO_TARGET_MS = String(10 * 60_000);
    client.queue(
      [{ count: '2' }],
      [{ count: '0' }],
      [{ created_at: FIVE_MIN_AGO, range_end: '800' }],
    );
    client.queue(
      [{ count: '0' }],
      [{ count: '0' }], [{ count: '0' }], [{ count: '0' }], [{ count: '0' }],
      [{ trigger_name: 'reconciliation_discrepancies_guard' }],
      [{ count: '0' }], [{ count: '0' }], [{ count: '0' }], [],
    );

    const spy = jest.spyOn(await import('node:fs'), 'readdirSync').mockReturnValue(
      Array.from({ length: 10 }, (_, i) => `m${i}.js`) as never,
    );
    const checker = new RestoreConsistencyChecker(client as never, '/fake');
    const report = await checker.run();
    spy.mockRestore();
    delete process.env.RESTORE_RPO_TARGET_MS;

    expect(typeof report.rpoWindowMs).toBe('number');
    expect(report.migrationCount).toBe(10);
    expect(typeof report.criticalFailures).toBe('number');
    expect(typeof report.warnings).toBe('number');
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ── G. Report builder helpers ─────────────────────────────────────────────

describe('G. Report builder helpers (restore-rehearsal.mjs)', () => {
  const { buildReport } = await import('../../scripts/restore-rehearsal.mjs');

  const baseConsistency = {
    passed: true,
    criticalFailures: 0,
    warnings: 0,
    rpoWindowMs: 2 * 60_000, // 2 min
    checks: [],
    migrationCount: 54,
    tableCount: 36,
    databaseUrl: 'postgres://***@localhost/rehearsal',
    startedAt: new Date(),
    completedAt: new Date(),
    durationMs: 1000,
  };

  it('G1. buildReport marks rto.breached=true when duration exceeds target', () => {
    const startedAt = new Date(Date.now() - 40 * 60_000); // 40 min ago
    process.env.RESTORE_RTO_TARGET_MINUTES = '30';
    const r = buildReport(baseConsistency, startedAt, null);
    delete process.env.RESTORE_RTO_TARGET_MINUTES;
    expect(r.rto.breached).toBe(true);
  });

  it('G2. buildReport marks rpo.breached=true when rpoWindowMs exceeds target', () => {
    process.env.RESTORE_RPO_TARGET_MINUTES = '5';
    const longRpo = { ...baseConsistency, rpoWindowMs: 10 * 60_000 }; // 10 min
    const r = buildReport(longRpo, new Date(), null);
    delete process.env.RESTORE_RPO_TARGET_MINUTES;
    expect(r.rpo.breached).toBe(true);
  });

  it('G3. buildReport passed=false when any breach occurs', () => {
    process.env.RESTORE_RTO_TARGET_MINUTES = '30';
    const startedAt = new Date(Date.now() - 40 * 60_000);
    const r = buildReport(baseConsistency, startedAt, null);
    delete process.env.RESTORE_RTO_TARGET_MINUTES;
    expect(r.passed).toBe(false);
    expect(r.failures.length).toBeGreaterThan(0);
  });

  it('G4. buildReport passed=true when all checks pass and within targets', () => {
    process.env.RESTORE_RTO_TARGET_MINUTES = '30';
    process.env.RESTORE_RPO_TARGET_MINUTES = '5';
    const startedAt = new Date(Date.now() - 5 * 60_000); // 5 min ago (within 30)
    const r = buildReport(baseConsistency, startedAt, null);
    delete process.env.RESTORE_RTO_TARGET_MINUTES;
    delete process.env.RESTORE_RPO_TARGET_MINUTES;
    expect(r.passed).toBe(true);
    expect(r.failures).toHaveLength(0);
  });
});
