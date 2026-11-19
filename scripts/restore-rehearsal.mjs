#!/usr/bin/env node
/**
 * scripts/restore-rehearsal.mjs — issue #859
 *
 * Orchestrates a full database restore rehearsal:
 *   1. Provision an isolated target database (Postgres on localhost or a
 *      service container in CI)
 *   2. Download the most recent logical backup from S3 (or use a local
 *      dump file supplied via --dump-file)
 *   3. Restore with psql into the isolated database
 *   4. Run database migrations to bring any schema gaps to the latest
 *   5. Execute all application-level consistency checks:
 *        - migration state
 *        - required table presence
 *        - row counts
 *        - ledger checkpoints + RPO window measurement
 *        - financial invariants (stroop integrity, FK constraints,
 *          immutability triggers, dual-control constraint)
 *   6. Record RTO (restore + check duration) and RPO (ledger checkpoint lag)
 *   7. Publish a machine-readable JSON report and a human-readable summary
 *   8. Exit 0 on success (all critical checks pass, RTO/RPO within targets);
 *      exit 1 on any critical failure or target breach
 *
 * Environment variables:
 *   DATABASE_URL                  Source or reference DB (not used for restore)
 *   REHEARSAL_DB_URL              Target isolated DB for the restore
 *                                 (default: postgres://postgres:postgres@localhost:5432/restore_rehearsal)
 *   BACKUP_S3_BUCKET              S3 bucket holding logical backups
 *   BACKUP_S3_REGION              AWS region (default: us-east-1)
 *   RESTORE_DUMP_FILE             Path to a local .sql or .sql.gz file; skips S3 download
 *   RESTORE_RTO_TARGET_MINUTES    Maximum acceptable restore+check time (default: 30)
 *   RESTORE_RPO_TARGET_MINUTES    Maximum acceptable ledger lag (default: 5)
 *   RESTORE_REHEARSAL_REPORT      Output path for the JSON report (default: restore-rehearsal-report.json)
 *   SKIP_RESTORE                  Set to '1' to skip pg_restore and only run checks (dev shortcut)
 *   SKIP_S3_DOWNLOAD              Set to '1' to skip S3 download (must supply RESTORE_DUMP_FILE)
 *
 * Usage:
 *   # Full rehearsal (CI — postgres service container already running)
 *   node scripts/restore-rehearsal.mjs
 *
 *   # Local dry-run with a pre-downloaded dump
 *   RESTORE_DUMP_FILE=./backup.sql.gz node scripts/restore-rehearsal.mjs
 *
 *   # Only run consistency checks (database already restored)
 *   SKIP_RESTORE=1 REHEARSAL_DB_URL=postgres://... node scripts/restore-rehearsal.mjs
 */

import { execSync, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const backendRoot = resolve(repoRoot, 'backend');
const migrationsDir = resolve(backendRoot, 'migrations');

// ── Config ────────────────────────────────────────────────────────────────

const REHEARSAL_DB_URL =
  process.env.REHEARSAL_DB_URL ??
  'postgres://postgres:postgres@localhost:5432/restore_rehearsal';

const RTO_TARGET_MS =
  Number.parseInt(process.env.RESTORE_RTO_TARGET_MINUTES ?? '30', 10) * 60_000;

const RPO_TARGET_MS =
  Number.parseInt(process.env.RESTORE_RPO_TARGET_MINUTES ?? '5', 10) * 60_000;

const REPORT_PATH = resolve(
  process.cwd(),
  process.env.RESTORE_REHEARSAL_REPORT ?? 'restore-rehearsal-report.json',
);

const SKIP_RESTORE = process.env.SKIP_RESTORE === '1';
const SKIP_S3_DOWNLOAD = process.env.SKIP_S3_DOWNLOAD === '1';

// ── Utilities ─────────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

function logError(msg) {
  const ts = new Date().toISOString();
  console.error(`[${ts}] ERROR: ${msg}`);
}

function run(cmd, opts = {}) {
  log(`$ ${cmd}`);
  execSync(cmd, { stdio: 'inherit', ...opts });
}

/** Parse host/port/user/pass/dbname from a postgres URL. */
function parseUrl(url) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: u.port || '5432',
    user: u.username || 'postgres',
    password: u.password || '',
    dbname: u.pathname.replace(/^\//, '') || 'postgres',
  };
}

function redactUrl(url) {
  try {
    const u = new URL(url);
    u.password = '***';
    u.username = u.username ? '***' : '';
    return u.toString();
  } catch {
    return '[invalid url]';
  }
}

// ── Step 1: Provision isolated target DB ─────────────────────────────────

async function provisionTargetDatabase() {
  log('Step 1: Provisioning isolated target database...');
  const { host, port, user, password, dbname } = parseUrl(REHEARSAL_DB_URL);

  // Connect to the postgres admin database to create/recreate the target.
  const adminUrl = REHEARSAL_DB_URL.replace(
    new RegExp(`/${dbname}$`),
    '/postgres',
  );

  const adminClient = new pg.Client({ connectionString: adminUrl });
  try {
    await adminClient.connect();
    // Drop if exists, then create fresh.
    await adminClient.query(`DROP DATABASE IF EXISTS "${dbname}"`);
    await adminClient.query(`CREATE DATABASE "${dbname}"`);
    log(`  Created database '${dbname}' on ${host}:${port}`);
  } catch (err) {
    throw new Error(`Failed to provision target database: ${err.message}`);
  } finally {
    await adminClient.end();
  }

  return { host, port, user, password, dbname };
}

// ── Step 2: Download backup from S3 ─────────────────────────────────────

async function downloadBackup() {
  if (process.env.RESTORE_DUMP_FILE) {
    const f = resolve(process.cwd(), process.env.RESTORE_DUMP_FILE);
    if (!existsSync(f)) throw new Error(`RESTORE_DUMP_FILE does not exist: ${f}`);
    log(`Step 2: Using local dump file: ${f}`);
    return f;
  }

  if (SKIP_S3_DOWNLOAD) {
    throw new Error(
      'SKIP_S3_DOWNLOAD=1 but no RESTORE_DUMP_FILE supplied. Provide one of them.',
    );
  }

  const bucket = process.env.BACKUP_S3_BUCKET;
  if (!bucket) {
    throw new Error(
      'BACKUP_S3_BUCKET is required. Set it or provide RESTORE_DUMP_FILE for a local run.',
    );
  }

  const region = process.env.BACKUP_S3_REGION ?? 'us-east-1';
  log(`Step 2: Finding latest backup in s3://${bucket}/ (${region})...`);

  const listOutput = execSync(
    `aws s3 ls s3://${bucket}/ --region ${region} | grep '\\.sql\\.gz$' | sort | tail -1`,
    { stdio: 'pipe' },
  )
    .toString()
    .trim();

  if (!listOutput) {
    throw new Error(`No .sql.gz backup files found in s3://${bucket}/`);
  }

  const parts = listOutput.split(/\s+/);
  const s3Key = parts[parts.length - 1];
  const localPath = `/tmp/restore-rehearsal-${Date.now()}.sql.gz`;

  log(`  Downloading s3://${bucket}/${s3Key} → ${localPath}`);
  run(`aws s3 cp s3://${bucket}/${s3Key} ${localPath} --region ${region}`);

  return localPath;
}

// ── Step 3: Restore into target DB ───────────────────────────────────────

async function restoreDatabase(dumpFile, dbInfo) {
  log(`Step 3: Restoring ${dumpFile} into '${dbInfo.dbname}'...`);

  const env = {
    ...process.env,
    PGPASSWORD: dbInfo.password,
  };

  const isGzipped = dumpFile.endsWith('.gz');
  const psqlCmd = `psql -h ${dbInfo.host} -p ${dbInfo.port} -U ${dbInfo.user} -d ${dbInfo.dbname}`;

  if (isGzipped) {
    run(`gunzip -c "${dumpFile}" | ${psqlCmd}`, { env, shell: true });
  } else {
    run(`${psqlCmd} -f "${dumpFile}"`, { env });
  }

  log('  Restore completed successfully.');
}

// ── Step 4: Run migrations ────────────────────────────────────────────────

async function runMigrations() {
  log('Step 4: Running migrations to bring schema to latest...');

  const result = spawnSync(
    'npm',
    ['run', 'migrate:up'],
    {
      cwd: backendRoot,
      env: { ...process.env, DATABASE_URL: REHEARSAL_DB_URL },
      stdio: 'inherit',
      shell: true,
    },
  );

  if (result.status !== 0) {
    throw new Error('Migration run failed — restored schema may be incompatible');
  }
  log('  Migrations applied successfully.');
}

// ── Step 5: Run consistency checks ───────────────────────────────────────

async function runConsistencyChecks() {
  log('Step 5: Running application-level consistency checks...');

  // Dynamic import because this is an MJS script importing a TS-compiled module.
  // The TypeScript source is compiled to dist/ before this script runs in CI.
  // During local development, use ts-node or tsx via the npm script.
  let runChecks;
  const compiledPath = resolve(backendRoot, 'dist/services/restoreConsistencyChecker.js');
  const sourcePath = resolve(backendRoot, 'src/services/restoreConsistencyChecker.ts');

  if (existsSync(compiledPath)) {
    ({ runConsistencyChecks: runChecks } = await import(compiledPath));
  } else if (existsSync(sourcePath)) {
    // Try tsx for local development
    const { execSync: syncExec } = await import('node:child_process');
    // Write a small inline runner and pipe the JSON output back
    const result = spawnSync(
      'npx',
      [
        'tsx',
        '--tsconfig',
        resolve(backendRoot, 'tsconfig.json'),
        '-e',
        `
          import { runConsistencyChecks } from './src/services/restoreConsistencyChecker.ts';
          runConsistencyChecks(process.env.REHEARSAL_DB_URL, process.env.MIGRATIONS_DIR)
            .then(r => { process.stdout.write(JSON.stringify(r)); process.exit(r.passed ? 0 : 1); })
            .catch(e => { process.stderr.write(e.message); process.exit(1); });
        `,
      ],
      {
        cwd: backendRoot,
        env: {
          ...process.env,
          REHEARSAL_DB_URL,
          MIGRATIONS_DIR: migrationsDir,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: true,
      },
    );
    if (result.stdout) {
      try {
        return JSON.parse(result.stdout.toString());
      } catch {
        // Fall through to native JS path below
      }
    }
    if (result.status !== 0) {
      throw new Error(
        `Consistency check process failed: ${result.stderr?.toString() ?? 'unknown error'}`,
      );
    }
  }

  if (!runChecks) {
    // Fallback: run a minimal native JS consistency check without TypeScript.
    return await runNativeConsistencyChecks();
  }

  return await runChecks(REHEARSAL_DB_URL, migrationsDir);
}

/** Native JS fallback that runs the most critical checks without TypeScript. */
async function runNativeConsistencyChecks() {
  log('  Running native JS consistency checks (compiled TS not found)...');
  const client = new pg.Client({ connectionString: REHEARSAL_DB_URL });
  await client.connect();

  const checks = [];

  try {
    // Migration table exists
    const mt = await client.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='pgmigrations' AND table_schema='public') AS e`,
    );
    checks.push({
      name: 'migration_table_exists',
      passed: mt.rows[0]?.e === true,
      severity: 'critical',
      detail: mt.rows[0]?.e ? 'pgmigrations exists' : 'pgmigrations MISSING',
    });

    // Migration count
    if (mt.rows[0]?.e) {
      const mc = await client.query(`SELECT COUNT(*)::text AS c FROM pgmigrations`);
      const diskFiles = existsSync(migrationsDir)
        ? readdirSync(migrationsDir).filter((f) => f.endsWith('.js'))
        : [];
      checks.push({
        name: 'migration_count',
        passed: true,
        severity: 'info',
        detail: `${mc.rows[0]?.c ?? 0} migrations applied, ${diskFiles.length} on disk`,
        value: Number(mc.rows[0]?.c ?? 0),
      });
    }

    // Stroop integrity
    const se = await client.query(
      `SELECT COUNT(*)::text AS c FROM contract_events WHERE amount IS NOT NULL AND amount<>trunc(amount)`,
    );
    const badStroops = Number(se.rows[0]?.c ?? 0);
    checks.push({
      name: 'stroop_integrity_contract_events',
      passed: badStroops === 0,
      severity: 'critical',
      detail: badStroops === 0 ? 'All amount values are whole stroops' : `${badStroops} fractional amount rows found`,
      value: badStroops,
    });

    // Guard trigger
    const gt = await client.query(
      `SELECT COUNT(*)::text AS c FROM information_schema.triggers WHERE trigger_name='reconciliation_discrepancies_guard' AND event_object_schema='public'`,
    );
    checks.push({
      name: 'reconciliation_guard_trigger',
      passed: Number(gt.rows[0]?.c ?? 0) > 0,
      severity: 'critical',
      detail: Number(gt.rows[0]?.c ?? 0) > 0 ? 'Guard trigger present' : 'Guard trigger MISSING',
    });

    // Ledger checkpoints
    const lc = await client.query(
      `SELECT MAX(created_at) AS latest FROM ledger_checkpoints WHERE status='verified'`,
    );
    const latestAt = lc.rows[0]?.latest ? new Date(lc.rows[0].latest) : null;
    const rpoWindowMs = latestAt ? Date.now() - latestAt.getTime() : null;
    checks.push({
      name: 'ledger_checkpoints_present',
      passed: latestAt !== null,
      severity: 'critical',
      detail: latestAt ? `Latest verified checkpoint at ${latestAt.toISOString()}` : 'No verified checkpoints found',
      value: rpoWindowMs,
    });

    const criticalFailures = checks.filter((c) => !c.passed && c.severity === 'critical').length;
    return {
      databaseUrl: redactUrl(REHEARSAL_DB_URL),
      startedAt: new Date(),
      completedAt: new Date(),
      durationMs: 0,
      passed: criticalFailures === 0,
      criticalFailures,
      warnings: checks.filter((c) => !c.passed && c.severity === 'warning').length,
      checks,
      rpoWindowMs,
      migrationCount: 0,
      tableCount: 0,
    };
  } finally {
    await client.end();
  }
}

// ── Step 6 & 7: Measure RTO/RPO and generate report ──────────────────────

function buildReport(consistencyReport, rehearsalStartedAt, dumpFile) {
  const rehearsalDurationMs = Date.now() - rehearsalStartedAt.getTime();
  const rtoBreached = rehearsalDurationMs > RTO_TARGET_MS;
  const rpoBreached =
    consistencyReport.rpoWindowMs !== null &&
    consistencyReport.rpoWindowMs > RPO_TARGET_MS;

  const report = {
    rehearsalId: `restore-rehearsal-${rehearsalStartedAt.getTime()}`,
    generatedAt: new Date().toISOString(),
    rehearsalStartedAt: rehearsalStartedAt.toISOString(),
    rehearsalCompletedAt: new Date().toISOString(),
    dumpFile: dumpFile ?? 'unknown',
    targetDatabase: redactUrl(REHEARSAL_DB_URL),

    // RTO measurement
    rto: {
      observedMs: rehearsalDurationMs,
      observedMinutes: Math.round(rehearsalDurationMs / 60000 * 10) / 10,
      targetMs: RTO_TARGET_MS,
      targetMinutes: RTO_TARGET_MS / 60000,
      breached: rtoBreached,
    },

    // RPO measurement
    rpo: {
      observedMs: consistencyReport.rpoWindowMs,
      observedMinutes:
        consistencyReport.rpoWindowMs !== null
          ? Math.round(consistencyReport.rpoWindowMs / 60000 * 10) / 10
          : null,
      targetMs: RPO_TARGET_MS,
      targetMinutes: RPO_TARGET_MS / 60000,
      breached: rpoBreached,
    },

    // Consistency check results
    consistency: consistencyReport,

    // Overall outcome
    passed:
      consistencyReport.passed &&
      !rtoBreached &&
      !rpoBreached,
    failures: [
      ...(consistencyReport.criticalFailures > 0
        ? [`${consistencyReport.criticalFailures} critical consistency check(s) failed`]
        : []),
      ...(rtoBreached
        ? [
            `RTO breached: ${Math.round(rehearsalDurationMs / 60000)}m observed vs ${RTO_TARGET_MS / 60000}m target`,
          ]
        : []),
      ...(rpoBreached
        ? [
            `RPO breached: ${Math.round(consistencyReport.rpoWindowMs / 60000)}m data-loss window vs ${RPO_TARGET_MS / 60000}m target`,
          ]
        : []),
    ],
  };

  return report;
}

function printSummary(report) {
  console.log('\n' + '═'.repeat(70));
  console.log('  DATABASE RESTORE REHEARSAL REPORT');
  console.log('═'.repeat(70));
  console.log(`  Rehearsal ID : ${report.rehearsalId}`);
  console.log(`  Generated at : ${report.generatedAt}`);
  console.log(`  Target DB    : ${report.targetDatabase}`);
  console.log('');
  console.log('  RTO');
  console.log(
    `    Observed : ${report.rto.observedMinutes}m  |  Target : ${report.rto.targetMinutes}m  |  ${report.rto.breached ? '❌ BREACHED' : '✓ OK'}`,
  );
  console.log('');
  console.log('  RPO (data-loss window)');
  const rpoObs =
    report.rpo.observedMinutes !== null ? `${report.rpo.observedMinutes}m` : 'n/a (no checkpoint)';
  console.log(
    `    Observed : ${rpoObs}  |  Target : ${report.rpo.targetMinutes}m  |  ${report.rpo.breached ? '❌ BREACHED' : '✓ OK'}`,
  );
  console.log('');
  console.log('  Consistency checks');

  const checks = report.consistency.checks ?? [];
  for (const c of checks) {
    const icon = c.passed ? '  ✓' : c.severity === 'critical' ? '  ✗' : '  ⚠';
    console.log(`${icon}  [${c.severity.toUpperCase()}] ${c.name}: ${c.detail}`);
  }

  console.log('');
  if (report.passed) {
    console.log('  OVERALL: ✓ PASS — all checks passed, RTO and RPO within targets');
  } else {
    console.log('  OVERALL: ✗ FAIL');
    for (const f of report.failures) {
      console.log(`    • ${f}`);
    }
  }
  console.log('═'.repeat(70) + '\n');
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const rehearsalStartedAt = new Date();
  log('=== Database restore rehearsal starting (issue #859) ===');
  log(`RTO target: ${RTO_TARGET_MS / 60000}m | RPO target: ${RPO_TARGET_MS / 60000}m`);

  let dumpFile = null;

  try {
    if (!SKIP_RESTORE) {
      await provisionTargetDatabase();
      dumpFile = await downloadBackup();
      await restoreDatabase(dumpFile, parseUrl(REHEARSAL_DB_URL));
      await runMigrations();
    } else {
      log('SKIP_RESTORE=1: skipping provision/download/restore/migrate steps');
    }

    const consistencyReport = await runConsistencyChecks();
    const report = buildReport(consistencyReport, rehearsalStartedAt, dumpFile);

    // Write JSON report
    const reportDir = dirname(REPORT_PATH);
    if (!existsSync(reportDir)) mkdirSync(reportDir, { recursive: true });
    writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');
    log(`Report written to ${REPORT_PATH}`);

    printSummary(report);

    if (!report.passed) {
      logError('Rehearsal FAILED — see report for details');
      process.exit(1);
    }

    log('Rehearsal PASSED');
    process.exit(0);
  } catch (err) {
    logError(`Rehearsal aborted: ${err.message}`);
    if (err.stack) console.error(err.stack);

    // Write a minimal failure report so CI can upload it.
    const failureReport = {
      rehearsalId: `restore-rehearsal-${rehearsalStartedAt.getTime()}`,
      generatedAt: new Date().toISOString(),
      passed: false,
      failures: [`Rehearsal aborted: ${err.message}`],
      rto: { observedMs: Date.now() - rehearsalStartedAt.getTime() },
      rpo: null,
      consistency: null,
    };
    try {
      const reportDir = dirname(REPORT_PATH);
      if (!existsSync(reportDir)) mkdirSync(reportDir, { recursive: true });
      writeFileSync(REPORT_PATH, JSON.stringify(failureReport, null, 2), 'utf8');
    } catch {
      // non-fatal
    }

    process.exit(1);
  }
}

// Allow importing without auto-running (for tests)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}

export { buildReport, printSummary, parseUrl };
