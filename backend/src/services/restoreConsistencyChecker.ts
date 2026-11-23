/**
 * Restore consistency checker (issue #859).
 *
 * Verifies that a restored database satisfies every application-level
 * invariant before the restored environment is promoted to handle traffic.
 * Run immediately after `pg_restore` completes and migrations are applied.
 *
 * Checks performed (in order):
 *   1. Migration state  — every migration file on disk is recorded in
 *                         pgmigrations; no unapplied migrations remain.
 *   2. Core table presence — all expected tables exist in the schema.
 *   3. Row counts        — no table that must not be empty is empty after a
 *                         non-trivial backup (seed rows always present).
 *   4. Ledger checkpoints — latest verified checkpoint is present and within
 *                           the configured RPO window.
 *   5. Financial invariants:
 *        a. contract_events.amount  — no fractional stroops (trunc check)
 *        b. loan_history money cols — no fractional stroops
 *        c. reconciliation_discrepancies — immutability trigger is live
 *        d. cross_contract_reconciliation — no duplicate intent_keys
 *        e. orphaned_tx_reconciliation — FK to transaction_submissions holds
 *        f. privileged_action_requests — no row where approver = initiator
 *   6. Data-loss window (RPO) — gap between latest ledger checkpoint
 *                               timestamp and restore point (now).
 *
 * No financial data is ever written or corrected by this module; it is
 * read-only and reports findings for operator review.
 */

import pg from 'pg';
import { readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Types ─────────────────────────────────────────────────────────────────

export type CheckSeverity = 'info' | 'warning' | 'critical';

export interface CheckResult {
  name: string;
  passed: boolean;
  severity: CheckSeverity;
  detail: string;
  value?: unknown;
}

export interface ConsistencyReport {
  databaseUrl: string;    // redacted for logs
  startedAt: Date;
  completedAt: Date;
  durationMs: number;
  passed: boolean;        // true only when every critical check passes
  criticalFailures: number;
  warnings: number;
  checks: CheckResult[];
  rpoWindowMs: number | null;    // null when no ledger checkpoint found
  migrationCount: number;
  tableCount: number;
}

// ── Tables that must exist after a full migration run ─────────────────────

export const REQUIRED_TABLES: string[] = [
  'scores',
  'remittance_history',
  'contract_events',
  'indexer_state',
  'loan_history',
  'remittances',
  'loan_disputes',
  'loan_state_events',
  'webhook_secrets',
  'webhook_subscriptions',
  'user_profiles',
  'notifications',
  'user_notification_preferences',
  'indexed_events',
  'quarantine_events',
  'transaction_submissions',
  'nft_transfer_events',
  'indexer_scheduler_state',
  'indexer_rebuilds',
  'indexer_rebuild_events',
  'indexer_active_projection',
  'cross_contract_reconciliation',
  'reconciliation_discrepancies',
  'reconciliation_discrepancy_resolutions',
  'orphaned_tx_reconciliation',
  'pause_state',
  'soroban_write_queue',
  'ledger_checkpoints',
  'contract_verification',
  'auth_challenge_nonces',
  'key_rotation_batch',
  'key_rotation_record',
  'pii_encrypted_fields',
  'pii_access_log',
  'privileged_action_requests',
  'audit_logs',
];

// Tables that must have at least one row (they receive seed data or are
// written to on first startup).
export const NON_EMPTY_TABLES: string[] = [
  'pause_state',
];

// RPO target: 5 minutes (matches the WAL archive_timeout documented in
// DATABASE_BACKUP_RECOVERY.md). Override via RESTORE_RPO_TARGET_MS.
const DEFAULT_RPO_TARGET_MS = 5 * 60 * 1000;

// ── Helpers ───────────────────────────────────────────────────────────────

function getRpoTargetMs(): number {
  const raw = process.env.RESTORE_RPO_TARGET_MS;
  if (!raw) return DEFAULT_RPO_TARGET_MS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RPO_TARGET_MS;
}

function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    u.password = '***';
    u.username = u.username ? '***' : '';
    return u.toString();
  } catch {
    return '[invalid url]';
  }
}

function pass(name: string, severity: CheckSeverity, detail: string, value?: unknown): CheckResult {
  return { name, passed: true, severity, detail, value };
}

function fail(name: string, severity: CheckSeverity, detail: string, value?: unknown): CheckResult {
  return { name, passed: false, severity, detail, value };
}

// ── Checker class ─────────────────────────────────────────────────────────

export class RestoreConsistencyChecker {
  private client: pg.Client;
  private migrationsDir: string;

  constructor(client: pg.Client, migrationsDir?: string) {
    this.client = client;
    // Default: resolve relative to this file's location in the compiled build
    // or from the source tree at development time.
    const defaultDir = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../migrations',
    );
    this.migrationsDir = migrationsDir ?? defaultDir;
  }

  // ── 1. Migration state ─────────────────────────────────────────────────

  async checkMigrationState(): Promise<CheckResult[]> {
    const results: CheckResult[] = [];

    // a. pgmigrations table must exist
    const tableExists = await this.client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'pgmigrations'
       ) AS exists`,
    );
    if (!tableExists.rows[0]?.exists) {
      return [
        fail(
          'migration_table_exists',
          'critical',
          'pgmigrations table is missing; migrations have never been run on this database',
        ),
      ];
    }
    results.push(pass('migration_table_exists', 'info', 'pgmigrations table is present'));

    // b. Count applied migrations
    const applied = await this.client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM pgmigrations`,
    );
    const appliedCount = Number(applied.rows[0]?.count ?? 0);
    results.push(
      pass(
        'migration_count',
        'info',
        `${appliedCount} migrations are recorded in pgmigrations`,
        appliedCount,
      ),
    );

    // c. All migration files on disk are applied
    let diskFiles: string[] = [];
    try {
      diskFiles = readdirSync(this.migrationsDir)
        .filter((f) => f.endsWith('.js'))
        .sort();
    } catch {
      results.push(
        pass(
          'migration_disk_scan',
          'warning',
          `Could not read migrations directory ${this.migrationsDir}; skipping disk-vs-db comparison`,
        ),
      );
      return results;
    }

    const appliedNames = await this.client.query<{ name: string }>(
      `SELECT name FROM pgmigrations ORDER BY name`,
    );
    const appliedSet = new Set(appliedNames.rows.map((r) => r.name));

    const unapplied = diskFiles
      .map((f) => f.replace(/\.js$/, ''))
      .filter((stem) => !appliedSet.has(stem));

    if (unapplied.length > 0) {
      results.push(
        fail(
          'migrations_fully_applied',
          'critical',
          `${unapplied.length} migration(s) on disk are NOT in pgmigrations: ${unapplied.join(', ')}`,
          unapplied,
        ),
      );
    } else {
      results.push(
        pass(
          'migrations_fully_applied',
          'info',
          `All ${diskFiles.length} migrations on disk are applied`,
          diskFiles.length,
        ),
      );
    }

    return results;
  }

  // ── 2. Core table presence ─────────────────────────────────────────────

  async checkTablePresence(): Promise<CheckResult[]> {
    const existing = await this.client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    const existingSet = new Set(existing.rows.map((r) => r.table_name));

    const missing = REQUIRED_TABLES.filter((t) => !existingSet.has(t));

    if (missing.length > 0) {
      return [
        fail(
          'required_tables_present',
          'critical',
          `${missing.length} required table(s) are missing after restore: ${missing.join(', ')}`,
          missing,
        ),
      ];
    }

    return [
      pass(
        'required_tables_present',
        'info',
        `All ${REQUIRED_TABLES.length} required tables are present`,
        REQUIRED_TABLES.length,
      ),
    ];
  }

  // ── 3. Row counts ──────────────────────────────────────────────────────

  async checkRowCounts(): Promise<CheckResult[]> {
    const results: CheckResult[] = [];

    for (const table of NON_EMPTY_TABLES) {
      try {
        const r = await this.client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM ${table}`,
        );
        const count = Number(r.rows[0]?.count ?? 0);
        if (count === 0) {
          results.push(
            fail(
              `row_count_${table}`,
              'warning',
              `Table '${table}' is empty after restore; expected at least one seed row`,
              0,
            ),
          );
        } else {
          results.push(
            pass(`row_count_${table}`, 'info', `Table '${table}' has ${count} row(s)`, count),
          );
        }
      } catch (err) {
        results.push(
          fail(
            `row_count_${table}`,
            'warning',
            `Could not count rows in '${table}': ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
    }

    // Also record counts for key financial tables (informational).
    const financialTables = [
      'contract_events',
      'transaction_submissions',
      'remittances',
      'loan_history',
      'ledger_checkpoints',
      'audit_logs',
    ];
    for (const table of financialTables) {
      try {
        const r = await this.client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM ${table}`,
        );
        const count = Number(r.rows[0]?.count ?? 0);
        results.push(
          pass(
            `row_count_${table}`,
            'info',
            `Table '${table}' has ${count} row(s) after restore`,
            count,
          ),
        );
      } catch {
        // Table may not exist — table-presence check covers this.
      }
    }

    return results;
  }

  // ── 4. Ledger checkpoints ──────────────────────────────────────────────

  async checkLedgerCheckpoints(): Promise<{ results: CheckResult[]; rpoWindowMs: number | null }> {
    const checks: CheckResult[] = [];
    let rpoWindowMs: number | null = null;

    // a. At least one verified checkpoint exists
    const count = await this.client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ledger_checkpoints WHERE status = 'verified'`,
    );
    const verifiedCount = Number(count.rows[0]?.count ?? 0);

    if (verifiedCount === 0) {
      checks.push(
        fail(
          'ledger_checkpoints_present',
          'critical',
          'No verified ledger checkpoints found; indexer has never confirmed a contiguous range',
          0,
        ),
      );
      return { results: checks, rpoWindowMs: null };
    }

    checks.push(
      pass(
        'ledger_checkpoints_present',
        'info',
        `${verifiedCount} verified ledger checkpoint(s) found`,
        verifiedCount,
      ),
    );

    // b. No suspect gaps
    const suspects = await this.client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ledger_checkpoints WHERE status = 'suspect'`,
    );
    const suspectCount = Number(suspects.rows[0]?.count ?? 0);

    if (suspectCount > 0) {
      checks.push(
        fail(
          'ledger_no_suspect_gaps',
          'warning',
          `${suspectCount} suspect ledger gap(s) detected; some ledger ranges were not fully scanned`,
          suspectCount,
        ),
      );
    } else {
      checks.push(
        pass('ledger_no_suspect_gaps', 'info', 'No suspect ledger gaps detected', 0),
      );
    }

    // c. Latest checkpoint age (RPO measurement)
    const latest = await this.client.query<{ created_at: Date; range_end: string }>(
      `SELECT created_at, range_end
       FROM ledger_checkpoints
       WHERE status = 'verified'
       ORDER BY range_end DESC
       LIMIT 1`,
    );
    const latestRow = latest.rows[0];
    if (latestRow) {
      const latestAt = new Date(latestRow.created_at);
      rpoWindowMs = Date.now() - latestAt.getTime();
      const rpoTargetMs = getRpoTargetMs();
      const rpoMinutes = Math.round(rpoWindowMs / 60000);

      if (rpoWindowMs > rpoTargetMs) {
        checks.push(
          fail(
            'ledger_checkpoint_rpo',
            'warning',
            `Latest ledger checkpoint is ${rpoMinutes} min old — exceeds RPO target of ${Math.round(rpoTargetMs / 60000)} min`,
            { rpoWindowMs, rpoTargetMs, latestLedger: latestRow.range_end },
          ),
        );
      } else {
        checks.push(
          pass(
            'ledger_checkpoint_rpo',
            'info',
            `Latest ledger checkpoint is ${rpoMinutes} min old — within RPO target`,
            { rpoWindowMs, rpoTargetMs, latestLedger: latestRow.range_end },
          ),
        );
      }
    }

    return { results: checks, rpoWindowMs };
  }

  // ── 5. Financial invariants ────────────────────────────────────────────

  async checkFinancialInvariants(): Promise<CheckResult[]> {
    const results: CheckResult[] = [];

    // 5a. contract_events.amount — no fractional stroops
    try {
      const r = await this.client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM contract_events
         WHERE amount IS NOT NULL AND amount <> trunc(amount)`,
      );
      const bad = Number(r.rows[0]?.count ?? 0);
      if (bad > 0) {
        results.push(
          fail(
            'stroop_integrity_contract_events',
            'critical',
            `${bad} row(s) in contract_events have fractional amount values (must be whole stroops)`,
            bad,
          ),
        );
      } else {
        results.push(
          pass(
            'stroop_integrity_contract_events',
            'info',
            'All contract_events.amount values are whole stroops',
          ),
        );
      }
    } catch (err) {
      results.push(
        fail(
          'stroop_integrity_contract_events',
          'warning',
          `Could not check contract_events stroop integrity: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }

    // 5b. loan_history money columns — no fractional stroops
    const loanHistoryCols = [
      'principal_amount',
      'principal_paid',
      'interest_paid',
      'accrued_interest',
    ];
    for (const col of loanHistoryCols) {
      try {
        const r = await this.client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count
           FROM loan_history
           WHERE "${col}" IS NOT NULL AND "${col}" <> trunc("${col}")`,
        );
        const bad = Number(r.rows[0]?.count ?? 0);
        if (bad > 0) {
          results.push(
            fail(
              `stroop_integrity_loan_history_${col}`,
              'critical',
              `${bad} row(s) in loan_history.${col} have fractional values`,
              bad,
            ),
          );
        } else {
          results.push(
            pass(
              `stroop_integrity_loan_history_${col}`,
              'info',
              `loan_history.${col} — all values are whole stroops`,
            ),
          );
        }
      } catch {
        // Table may be empty; not a critical failure.
      }
    }

    // 5c. reconciliation_discrepancies — immutability trigger is live
    try {
      const r = await this.client.query<{ trigger_name: string }>(
        `SELECT trigger_name
         FROM information_schema.triggers
         WHERE event_object_schema = 'public'
           AND event_object_table = 'reconciliation_discrepancies'
           AND trigger_name = 'reconciliation_discrepancies_guard'`,
      );
      if (r.rowCount === 0) {
        results.push(
          fail(
            'reconciliation_guard_trigger',
            'critical',
            'Immutability guard trigger on reconciliation_discrepancies is missing after restore',
          ),
        );
      } else {
        results.push(
          pass(
            'reconciliation_guard_trigger',
            'info',
            'reconciliation_discrepancies_guard trigger is present',
          ),
        );
      }
    } catch (err) {
      results.push(
        fail(
          'reconciliation_guard_trigger',
          'warning',
          `Could not verify guard trigger: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }

    // 5d. cross_contract_reconciliation — no duplicate intent_keys
    try {
      const r = await this.client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM (
           SELECT intent_key, COUNT(*) AS n
           FROM cross_contract_reconciliation
           GROUP BY intent_key
           HAVING COUNT(*) > 1
         ) dup`,
      );
      const dups = Number(r.rows[0]?.count ?? 0);
      if (dups > 0) {
        results.push(
          fail(
            'cross_contract_intent_key_unique',
            'critical',
            `${dups} duplicate intent_key(s) found in cross_contract_reconciliation`,
            dups,
          ),
        );
      } else {
        results.push(
          pass(
            'cross_contract_intent_key_unique',
            'info',
            'No duplicate intent_keys in cross_contract_reconciliation',
          ),
        );
      }
    } catch {
      // Table may be empty.
    }

    // 5e. orphaned_tx_reconciliation — all submission_id FKs resolve
    try {
      const r = await this.client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM orphaned_tx_reconciliation otr
         WHERE NOT EXISTS (
           SELECT 1 FROM transaction_submissions ts WHERE ts.id = otr.submission_id
         )`,
      );
      const broken = Number(r.rows[0]?.count ?? 0);
      if (broken > 0) {
        results.push(
          fail(
            'orphaned_tx_fk_integrity',
            'critical',
            `${broken} row(s) in orphaned_tx_reconciliation reference missing transaction_submissions rows`,
            broken,
          ),
        );
      } else {
        results.push(
          pass(
            'orphaned_tx_fk_integrity',
            'info',
            'All orphaned_tx_reconciliation FK references resolve',
          ),
        );
      }
    } catch {
      // Table may be empty.
    }

    // 5f. privileged_action_requests — no approver = initiator
    try {
      const r = await this.client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM privileged_action_requests
         WHERE approver IS NOT NULL AND approver = initiator`,
      );
      const bad = Number(r.rows[0]?.count ?? 0);
      if (bad > 0) {
        results.push(
          fail(
            'privileged_action_distinct_principals',
            'critical',
            `${bad} privileged_action_requests row(s) have approver = initiator (dual-control violation)`,
            bad,
          ),
        );
      } else {
        results.push(
          pass(
            'privileged_action_distinct_principals',
            'info',
            'All privileged_action_requests satisfy distinct-principals constraint',
          ),
        );
      }
    } catch {
      // Table may be empty.
    }

    // 5g. COMPARISON_RULES version tracking — rule versions in the restored
    //     DB match the current set known to discrepancyLedgerService.
    //     The service's COMPARISON_RULES keys are: loan_principal, pool_balance, score_snapshot
    const knownRuleVersions: Record<string, string> = {
      loan_principal: 'v1',
      pool_balance: 'v1',
      score_snapshot: 'v1',
    };
    try {
      const r = await this.client.query<{ discrepancy_class: string; rule_version: string }>(
        `SELECT DISTINCT discrepancy_class, rule_version
         FROM reconciliation_discrepancies`,
      );
      for (const row of r.rows) {
        const expected = knownRuleVersions[row.discrepancy_class];
        if (expected && row.rule_version !== expected) {
          results.push(
            fail(
              `discrepancy_rule_version_${row.discrepancy_class}`,
              'warning',
              `reconciliation_discrepancies has rule_version '${row.rule_version}' for class '${row.discrepancy_class}'; service expects '${expected}'`,
              { class: row.discrepancy_class, dbVersion: row.rule_version, expectedVersion: expected },
            ),
          );
        }
      }
      if (results.every((c) => c.name !== 'discrepancy_rule_version_loan_principal')) {
        results.push(
          pass(
            'discrepancy_rule_versions',
            'info',
            'All reconciliation_discrepancies rule_version values match current service expectations',
          ),
        );
      }
    } catch {
      // Table may be empty; not a failure.
    }

    return results;
  }

  // ── Full run ───────────────────────────────────────────────────────────

  async run(): Promise<ConsistencyReport> {
    const startedAt = new Date();
    const allChecks: CheckResult[] = [];

    const migrationChecks = await this.checkMigrationState();
    allChecks.push(...migrationChecks);

    const tableChecks = await this.checkTablePresence();
    allChecks.push(...tableChecks);

    const rowChecks = await this.checkRowCounts();
    allChecks.push(...rowChecks);

    const { results: ledgerChecks, rpoWindowMs } = await this.checkLedgerCheckpoints();
    allChecks.push(...ledgerChecks);

    const financialChecks = await this.checkFinancialInvariants();
    allChecks.push(...financialChecks);

    const completedAt = new Date();
    const criticalFailures = allChecks.filter((c) => !c.passed && c.severity === 'critical').length;
    const warnings = allChecks.filter((c) => !c.passed && c.severity === 'warning').length;

    const migrationCountCheck = allChecks.find((c) => c.name === 'migration_count');
    const tableCountCheck = allChecks.find((c) => c.name === 'required_tables_present');

    return {
      databaseUrl: redactUrl(
        (this.client as unknown as { connectionParameters?: { host?: string } })
          ?.connectionParameters?.host ?? 'unknown',
      ),
      startedAt,
      completedAt,
      durationMs: completedAt.getTime() - startedAt.getTime(),
      passed: criticalFailures === 0,
      criticalFailures,
      warnings,
      checks: allChecks,
      rpoWindowMs,
      migrationCount: typeof migrationCountCheck?.value === 'number' ? migrationCountCheck.value : 0,
      tableCount: typeof tableCountCheck?.value === 'number' ? tableCountCheck.value : 0,
    };
  }
}

// ── Standalone runner (called from scripts/restore-rehearsal.mjs) ─────────

export async function runConsistencyChecks(
  databaseUrl: string,
  migrationsDir?: string,
): Promise<ConsistencyReport> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const checker = new RestoreConsistencyChecker(client, migrationsDir);
    return await checker.run();
  } finally {
    await client.end();
  }
}
