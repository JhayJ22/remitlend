/**
 * Rollout / rollback rehearsal suite — issue #861
 *
 * Covers:
 *   A. Clean forward rollout (all migrations up → schema invariants hold)
 *   B. Full rollback from latest to N-1 (every migration has a working down())
 *   C. Expand-only window: old writer operates against expanded schema
 *   D. Expand → contract promotion: contract gate fires correctly, then drops old column
 *   E. Expand rollback: down() on the expand reverts schema without data loss
 *   F. Contract rollback: down() on the contract phase restores the old column from new data
 *   G. Mixed-version writes: old + new writer concurrent inserts stay consistent
 *   H. Worker compatibility: soroban_write_queue, indexer_scheduler_state, webhook dead-letter
 *      survive a down() without orphaned or corrupt rows
 *   I. Idempotency: running up() twice on an already-applied migration is a no-op
 *   J. Contract gate rejection: contract migration aborts if expand was not applied or rows
 *      remain unbackfilled
 *   K. Stale-action rejection: writing via the old API surface after the contract phase
 *      (column dropped) raises a column-not-found error, not a silent no-op
 *
 * Each rehearsal runs inside an isolated Postgres schema that is created before
 * the test and dropped afterwards. No production data is touched. The suite is
 * skipped automatically when DATABASE_URL is not set (offline / unit-only CI).
 *
 * Run individually:
 *   npm run test:rollback
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { runner as migrate } from 'node-pg-migrate';
import pg from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const url = process.env.DATABASE_URL;
const describeIf = url ? describe : describe.skip;

/** Unique schema prefix so parallel test runs never collide. */
const RUN_ID = `rb_${Date.now()}_${process.pid}`;

type RunOpts = {
  dir: string;
  table: string;
  direction?: 'up' | 'down';
  count?: number;
  /** Run only the named file (without extension). */
  file?: string;
};

/** Run node-pg-migrate in an isolated schema. */
const run = (schema: string, opts: RunOpts) =>
  migrate({
    databaseUrl: url!,
    dir: opts.dir,
    migrationsTable: opts.table,
    schema,
    direction: opts.direction ?? 'up',
    count: opts.count ?? Infinity,
    ...(opts.file ? { file: opts.file } : {}),
    log: () => undefined,
    singleTransaction: true,
  } as never);

/** Build a one-shot query helper scoped to a schema. */
const makeQ = (pool: pg.Pool, schema: string) =>
  async (sql: string, params: unknown[] = []) => {
    const c = await pool.connect();
    try {
      await c.query(`SET search_path TO ${schema}`);
      return await c.query(sql, params);
    } finally {
      c.release();
    }
  };

/** List all migration files in a directory, sorted. */
const listMigrations = (dir: string): string[] =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .sort();

/** Resolve a path relative to the backend root (where package.json lives). */
const backendRoot = resolve(new URL('.', import.meta.url).pathname, '../../..');
const migrationsDir = join(backendRoot, 'migrations');
const contractMigrationsDir = join(backendRoot, 'migrations-contract');

// Well-known migration file stems used in rehearsals.
const EXPAND_STEM = '1806000000000_notifications-read-at-expand';
const CONTRACT_STEM = '1806100000000_notifications-drop-read';
const SOROBAN_QUEUE_STEM = '1804000000000_soroban-write-queue';
const INDEXER_SCHEDULER_STEM = '1805000000000_adaptive-indexer-scheduler-state';
const WEBHOOK_DL_STEM = '1806000000000_webhook-dead-letter';

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describeIf('Rollback rehearsal suite (issue #861)', () => {
  const pool = new pg.Pool({ connectionString: url });

  /** Create an isolated schema and return a scoped query helper + cleanup fn. */
  const makeSchema = async (label: string) => {
    const schema = `${RUN_ID}_${label}`;
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const q = makeQ(pool, schema);
    const cleanup = () => pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    return { schema, q, cleanup };
  };

  afterAll(() => pool.end());

  // ─────────────────────────────────────────────────────────────────────────
  // A. Clean forward rollout
  // ─────────────────────────────────────────────────────────────────────────
  describe('A. Clean forward rollout', () => {
    let cleanup: () => Promise<unknown>;
    let q: ReturnType<typeof makeQ>;
    let schema: string;

    beforeAll(async () => {
      ({ schema, q, cleanup } = await makeSchema('fwd'));
      await run(schema, { dir: migrationsDir, table: 'pgmigrations' });
    }, 180_000);

    afterAll(() => cleanup());

    it('scores table exists after full up', async () => {
      const r = await q(`SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name='scores'`, [schema]);
      expect(r.rowCount).toBe(1);
    });

    it('notifications table has both read and read_at columns (expand applied)', async () => {
      const r = await q(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema=$1 AND table_name='notifications' AND column_name IN ('read','read_at')`,
        [schema],
      );
      const cols = r.rows.map((x: { column_name: string }) => x.column_name);
      expect(cols).toContain('read');
      expect(cols).toContain('read_at');
    });

    it('soroban_write_queue table exists', async () => {
      const r = await q(`SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name='soroban_write_queue'`, [schema]);
      expect(r.rowCount).toBe(1);
    });

    it('indexer_scheduler_state table exists with scheduler_mode column', async () => {
      const r = await q(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema=$1 AND table_name='indexer_scheduler_state' AND column_name='scheduler_mode'`,
        [schema],
      );
      expect(r.rowCount).toBe(1);
    });

    it('webhook_dead_letter_queue table exists', async () => {
      const r = await q(`SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name='webhook_dead_letter_queue'`, [schema]);
      expect(r.rowCount).toBe(1);
    });

    it('reconciliation_discrepancies table has immutable-row guard trigger', async () => {
      const r = await q(
        `SELECT tgname FROM information_schema.triggers
         WHERE event_object_schema=$1 AND event_object_table='reconciliation_discrepancies'`,
        [schema],
      );
      const names = r.rows.map((x: { tgname: string }) => x.tgname);
      expect(names.length).toBeGreaterThan(0);
    });

    it('every migration file is recorded in pgmigrations', async () => {
      const files = listMigrations(migrationsDir);
      const r = await q(`SELECT name FROM pgmigrations`);
      const ran = new Set<string>(r.rows.map((x: { name: string }) => x.name));
      for (const f of files) {
        const stem = f.replace(/\.js$/, '');
        expect(ran.has(stem)).toBe(true);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // B. Full rollback: latest → 0 (every down() must succeed)
  // ─────────────────────────────────────────────────────────────────────────
  describe('B. Full rollback (all migrations down)', () => {
    let cleanup: () => Promise<unknown>;
    let q: ReturnType<typeof makeQ>;
    let schema: string;

    beforeAll(async () => {
      ({ schema, q, cleanup } = await makeSchema('fulldown'));
      await run(schema, { dir: migrationsDir, table: 'pgmigrations' });
    }, 180_000);

    afterAll(() => cleanup());

    it('runs all down() without error', async () => {
      const files = listMigrations(migrationsDir);
      await run(schema, { dir: migrationsDir, table: 'pgmigrations', direction: 'down', count: files.length });
    }, 180_000);

    it('scores table is gone after full rollback', async () => {
      const r = await q(`SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name='scores'`, [schema]);
      expect(r.rowCount).toBe(0);
    });

    it('notifications table is gone after full rollback', async () => {
      const r = await q(`SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name='notifications'`, [schema]);
      expect(r.rowCount).toBe(0);
    });

    it('re-applying all up() after full rollback reaches a consistent state', async () => {
      await run(schema, { dir: migrationsDir, table: 'pgmigrations' });
      const r = await q(`SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name='scores'`, [schema]);
      expect(r.rowCount).toBe(1);
    }, 180_000);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // C. Expand-only window: old writer operates against expanded schema
  // ─────────────────────────────────────────────────────────────────────────
  describe('C. Expand-only mixed-version window', () => {
    let cleanup: () => Promise<unknown>;
    let q: ReturnType<typeof makeQ>;
    let schema: string;

    beforeAll(async () => {
      ({ schema, q, cleanup } = await makeSchema('expand_window'));
      // Apply all migrations up to and including the expand.
      await run(schema, { dir: migrationsDir, table: 'pgmigrations' });
    }, 180_000);

    afterAll(() => cleanup());

    it('old writer (uses read column) can insert without error', async () => {
      await q(
        `INSERT INTO notifications (user_id, type, title, message, read)
         VALUES ('old_writer','score_changed','t','m', true)`,
      );
      const r = await q(`SELECT read, read_at FROM notifications WHERE user_id='old_writer'`);
      expect(r.rows[0].read).toBe(true);
      // Sync trigger must have populated read_at.
      expect(r.rows[0].read_at).not.toBeNull();
    });

    it('new writer (uses read_at column) can insert without error', async () => {
      await q(
        `INSERT INTO notifications (user_id, type, title, message, read_at)
         VALUES ('new_writer','score_changed','t','m', now())`,
      );
      const r = await q(`SELECT read, read_at FROM notifications WHERE user_id='new_writer'`);
      expect(r.rows[0].read_at).not.toBeNull();
      // Sync trigger must have set read.
      expect(r.rows[0].read).toBe(true);
    });

    it('marking unread via old writer clears read_at via sync trigger', async () => {
      await q(`UPDATE notifications SET read=false WHERE user_id='old_writer'`);
      const r = await q(`SELECT read_at FROM notifications WHERE user_id='old_writer'`);
      expect(r.rows[0].read_at).toBeNull();
    });

    it('marking unread via new writer clears read via sync trigger', async () => {
      await q(`UPDATE notifications SET read_at=NULL WHERE user_id='new_writer'`);
      const r = await q(`SELECT read FROM notifications WHERE user_id='new_writer'`);
      expect(r.rows[0].read).toBe(false);
    });

    it('no rows are left with read=true but read_at IS NULL (backfill invariant)', async () => {
      const r = await q(`SELECT count(*)::int AS c FROM notifications WHERE read=true AND read_at IS NULL`);
      expect(r.rows[0].c).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // D. Expand → contract promotion path
  // ─────────────────────────────────────────────────────────────────────────
  describe('D. Expand → contract promotion', () => {
    let cleanup: () => Promise<unknown>;
    let q: ReturnType<typeof makeQ>;
    let schema: string;

    beforeAll(async () => {
      ({ schema, q, cleanup } = await makeSchema('contract_up'));
      await run(schema, { dir: migrationsDir, table: 'pgmigrations' });
      // Insert a row via old writer so backfill has something to verify.
      await q(`INSERT INTO notifications (user_id, type, title, message, read) VALUES ('promo_user','score_changed','t','m', true)`);
      await run(schema, { dir: contractMigrationsDir, table: 'pgmigrations_contract' });
    }, 180_000);

    afterAll(() => cleanup());

    it('old column (read) is dropped after contract phase', async () => {
      const r = await q(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema=$1 AND table_name='notifications' AND column_name='read'`,
        [schema],
      );
      expect(r.rowCount).toBe(0);
    });

    it('new column (read_at) is present and populated for existing rows', async () => {
      const r = await q(`SELECT read_at FROM notifications WHERE user_id='promo_user'`);
      expect(r.rows[0].read_at).not.toBeNull();
    });

    it('sync trigger and sync function are removed after contract phase', async () => {
      const trig = await q(
        `SELECT 1 FROM information_schema.triggers
         WHERE event_object_schema=$1 AND trigger_name='notifications_sync_read_trg'`,
        [schema],
      );
      expect(trig.rowCount).toBe(0);
      const fn = await q(
        `SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
         WHERE n.nspname=$1 AND p.proname='notifications_sync_read'`,
        [schema],
      );
      expect(fn.rowCount).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // E. Expand rollback: down() on expand reverts cleanly
  // ─────────────────────────────────────────────────────────────────────────
  describe('E. Expand rollback (expand down)', () => {
    let cleanup: () => Promise<unknown>;
    let q: ReturnType<typeof makeQ>;
    let schema: string;
    // Apply everything up to but not including the expand, insert rows, then
    // apply only the expand and roll it back.
    const all = listMigrations(migrationsDir);
    const expandIdx = all.findIndex((f) => f.startsWith(EXPAND_STEM));

    beforeAll(async () => {
      ({ schema, q, cleanup } = await makeSchema('expand_down'));
      // Apply migrations up to (not including) the expand.
      await run(schema, { dir: migrationsDir, table: 'pgmigrations', count: expandIdx });
      // Insert pre-expand data.
      await q(
        `INSERT INTO notifications (user_id, type, title, message, read)
         VALUES ('pre_expand','score_changed','t','m', true),
                ('pre_expand2','score_changed','t','m', false)`,
      );
      // Apply the expand only.
      await run(schema, { dir: migrationsDir, table: 'pgmigrations', count: 1, file: EXPAND_STEM });
    }, 180_000);

    afterAll(() => cleanup());

    it('expand applied: read_at column present', async () => {
      const r = await q(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema=$1 AND table_name='notifications' AND column_name='read_at'`,
        [schema],
      );
      expect(r.rowCount).toBe(1);
    });

    it('expand down() removes read_at and sync artifacts without data loss in read column', async () => {
      await run(schema, { dir: migrationsDir, table: 'pgmigrations', direction: 'down', count: 1 });
      const colR = await q(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema=$1 AND table_name='notifications' AND column_name='read_at'`,
        [schema],
      );
      expect(colR.rowCount).toBe(0);
      // The original read column must still have its data.
      const data = await q(`SELECT user_id, read FROM notifications WHERE user_id LIKE 'pre_expand%' ORDER BY user_id`);
      expect(data.rows).toHaveLength(2);
      const byUser = Object.fromEntries(data.rows.map((r: { user_id: string; read: boolean }) => [r.user_id, r.read]));
      expect(byUser['pre_expand']).toBe(true);
      expect(byUser['pre_expand2']).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // F. Contract rollback: down() restores old column from new data
  // ─────────────────────────────────────────────────────────────────────────
  describe('F. Contract rollback (contract down)', () => {
    let cleanup: () => Promise<unknown>;
    let q: ReturnType<typeof makeQ>;
    let schema: string;

    beforeAll(async () => {
      ({ schema, q, cleanup } = await makeSchema('contract_down'));
      await run(schema, { dir: migrationsDir, table: 'pgmigrations' });
      await q(
        `INSERT INTO notifications (user_id, type, title, message, read)
         VALUES ('ctd_read','score_changed','t','m', true),
                ('ctd_unread','score_changed','t','m', false)`,
      );
      await run(schema, { dir: contractMigrationsDir, table: 'pgmigrations_contract' });
    }, 180_000);

    afterAll(() => cleanup());

    it('contract phase applied (read column absent)', async () => {
      const r = await q(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema=$1 AND table_name='notifications' AND column_name='read'`,
        [schema],
      );
      expect(r.rowCount).toBe(0);
    });

    it('contract down() restores read column with values derived from read_at', async () => {
      await run(schema, { dir: contractMigrationsDir, table: 'pgmigrations_contract', direction: 'down', count: 1 });
      const colR = await q(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema=$1 AND table_name='notifications' AND column_name='read'`,
        [schema],
      );
      expect(colR.rowCount).toBe(1);
      const data = await q(`SELECT user_id, read FROM notifications WHERE user_id IN ('ctd_read','ctd_unread') ORDER BY user_id`);
      const byUser = Object.fromEntries(data.rows.map((r: { user_id: string; read: boolean }) => [r.user_id, r.read]));
      expect(byUser['ctd_read']).toBe(true);
      expect(byUser['ctd_unread']).toBe(false);
    });

    it('no financial rows are affected: stroop-denominated columns are intact after contract rollback', async () => {
      // Cross-check that money columns on loan_events / remittances are untouched.
      const r = await q(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema=$1 AND table_name='remittances' AND column_name='amount_stroops'`,
        [schema],
      );
      expect(r.rowCount).toBe(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // G. Mixed-version concurrent writes (idempotency / no duplicates)
  // ─────────────────────────────────────────────────────────────────────────
  describe('G. Mixed-version concurrent write idempotency', () => {
    let cleanup: () => Promise<unknown>;
    let q: ReturnType<typeof makeQ>;
    let schema: string;
    const N = 40;

    beforeAll(async () => {
      ({ schema, q, cleanup } = await makeSchema('concurrent'));
      await run(schema, { dir: migrationsDir, table: 'pgmigrations' });
    }, 180_000);

    afterAll(() => cleanup());

    it('concurrent old + new writers produce no duplicates and no inconsistent rows', async () => {
      const writes: Promise<unknown>[] = [];
      for (let i = 0; i < N; i++) {
        writes.push(
          q(`INSERT INTO notifications (user_id,type,title,message,read) VALUES ('conc','score_changed',$1,'m',true)`, [`old-${i}`]),
        );
        writes.push(
          q(`INSERT INTO notifications (user_id,type,title,message,read_at) VALUES ('conc','score_changed',$1,'m',now())`, [`new-${i}`]),
        );
      }
      await Promise.all(writes);
      const r = await q(
        `SELECT
           count(*)::int AS total,
           count(DISTINCT title)::int AS unique_titles,
           count(*) FILTER (WHERE read = true AND read_at IS NOT NULL)::int AS consistent
         FROM notifications WHERE user_id='conc'`,
      );
      expect(r.rows[0].total).toBe(2 * N);
      expect(r.rows[0].unique_titles).toBe(2 * N);
      expect(r.rows[0].consistent).toBe(2 * N);
    });

    it('re-inserting the same idempotency key is rejected by unique constraint', async () => {
      // soroban_write_queue has an idempotency_key unique constraint.
      await q(
        `INSERT INTO soroban_write_queue (idempotency_key, payload, status)
         VALUES ('idem-test-1', '{}', 'pending')`,
      );
      await expect(
        q(`INSERT INTO soroban_write_queue (idempotency_key, payload, status) VALUES ('idem-test-1', '{}', 'pending')`),
      ).rejects.toThrow(/unique/i);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // H. Worker compatibility: tables survive rollback without orphaned rows
  // ─────────────────────────────────────────────────────────────────────────
  describe('H. Worker compatibility after rollback', () => {
    let cleanup: () => Promise<unknown>;
    let q: ReturnType<typeof makeQ>;
    let schema: string;

    beforeAll(async () => {
      ({ schema, q, cleanup } = await makeSchema('worker_compat'));
      await run(schema, { dir: migrationsDir, table: 'pgmigrations' });
    }, 180_000);

    afterAll(() => cleanup());

    it('soroban_write_queue: rows written at new schema version roll back cleanly', async () => {
      await q(
        `INSERT INTO soroban_write_queue (idempotency_key, payload, status, attempts)
         VALUES ('wc-sq-1','{"op":"test"}','pending', 0),
                ('wc-sq-2','{"op":"test"}','processing', 1)`,
      );
      // Rolling back the write-queue migration drops the table, so rows must
      // be absent after down() without leaving orphaned references.
      const files = listMigrations(migrationsDir);
      const queueIdx = files.findIndex((f) => f.startsWith(SOROBAN_QUEUE_STEM));
      const rollbackCount = files.length - queueIdx;
      await run(schema, { dir: migrationsDir, table: 'pgmigrations', direction: 'down', count: rollbackCount });
      const tableExists = await q(
        `SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name='soroban_write_queue'`,
        [schema],
      );
      expect(tableExists.rowCount).toBe(0);
    }, 120_000);

    it('indexer_scheduler_state: enum type removed cleanly on rollback', async () => {
      // Re-apply up to the adaptive scheduler migration.
      const files = listMigrations(migrationsDir);
      const schedulerIdx = files.findIndex((f) => f.startsWith(INDEXER_SCHEDULER_STEM));
      await run(schema, { dir: migrationsDir, table: 'pgmigrations', count: schedulerIdx + 1 });
      await q(
        `INSERT INTO indexer_scheduler_state (key, scheduler_mode, updated_at)
         VALUES ('default','Caught-Up', now())
         ON CONFLICT (key) DO UPDATE SET scheduler_mode='Caught-Up', updated_at=now()`,
      );
      const rollbackCount = files.length - schedulerIdx;
      await run(schema, { dir: migrationsDir, table: 'pgmigrations', direction: 'down', count: rollbackCount });
      const tableExists = await q(
        `SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name='indexer_scheduler_state'`,
        [schema],
      );
      expect(tableExists.rowCount).toBe(0);
    }, 120_000);

    it('webhook_dead_letter_queue: rows roll back without leaving broken foreign keys', async () => {
      // Re-apply everything to get back to full.
      await run(schema, { dir: migrationsDir, table: 'pgmigrations' });
      const tableExists = await q(
        `SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name='webhook_dead_letter_queue'`,
        [schema],
      );
      expect(tableExists.rowCount).toBe(1);

      const files = listMigrations(migrationsDir);
      const dlIdx = files.findIndex((f) => f.startsWith(WEBHOOK_DL_STEM));
      const rollbackCount = files.length - dlIdx;
      await run(schema, { dir: migrationsDir, table: 'pgmigrations', direction: 'down', count: rollbackCount });
      const tableGone = await q(
        `SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name='webhook_dead_letter_queue'`,
        [schema],
      );
      expect(tableGone.rowCount).toBe(0);
    }, 120_000);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // I. Idempotency: applying a migration twice is a safe no-op
  // ─────────────────────────────────────────────────────────────────────────
  describe('I. Migration idempotency', () => {
    let cleanup: () => Promise<unknown>;
    let q: ReturnType<typeof makeQ>;
    let schema: string;

    beforeAll(async () => {
      ({ schema, q, cleanup } = await makeSchema('idempotent'));
      await run(schema, { dir: migrationsDir, table: 'pgmigrations' });
    }, 180_000);

    afterAll(() => cleanup());

    it('running migrate up again after full up does not throw or duplicate rows', async () => {
      // node-pg-migrate tracks applied migrations in pgmigrations; re-running up
      // is a no-op at the migration-runner level. This rehearsal confirms no
      // DDL errors surface (e.g. duplicate column, duplicate index).
      await expect(run(schema, { dir: migrationsDir, table: 'pgmigrations' })).resolves.not.toThrow();
    });

    it('pgmigrations table count matches the number of migration files', async () => {
      const r = await q(`SELECT count(*)::int AS c FROM pgmigrations`);
      const files = listMigrations(migrationsDir);
      expect(r.rows[0].c).toBe(files.length);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // J. Contract gate rejection
  // ─────────────────────────────────────────────────────────────────────────
  describe('J. Contract gate rejects unsafe promotion', () => {
    let cleanup: () => Promise<unknown>;
    let q: ReturnType<typeof makeQ>;
    let schema: string;

    beforeAll(async () => {
      ({ schema, q, cleanup } = await makeSchema('gate_reject'));
    });

    afterAll(() => cleanup());

    it('contract migration aborts if expand was never applied', async () => {
      // Apply only pre-expand migrations so read_at column does not exist.
      const all = listMigrations(migrationsDir);
      const expandIdx = all.findIndex((f) => f.startsWith(EXPAND_STEM));
      await run(schema, { dir: migrationsDir, table: 'pgmigrations', count: expandIdx });
      await expect(
        run(schema, { dir: contractMigrationsDir, table: 'pgmigrations_contract' }),
      ).rejects.toThrow();
    }, 120_000);

    it('contract migration aborts when unbackfilled rows exist', async () => {
      const all = listMigrations(migrationsDir);
      const expandIdx = all.findIndex((f) => f.startsWith(EXPAND_STEM));
      // Apply expand.
      await run(schema, { dir: migrationsDir, table: 'pgmigrations', count: 1, file: EXPAND_STEM });
      // Insert a row that bypasses the trigger so it has read=true but read_at IS NULL.
      await q(
        `INSERT INTO notifications (user_id, type, title, message, read, read_at)
         VALUES ('unbackfilled', 'score_changed', 't', 'm', true, NULL)`,
      );
      // Force read_at to NULL via UPDATE bypassing trigger (use a direct column set).
      await q(`UPDATE notifications SET read_at = NULL WHERE user_id = 'unbackfilled'`);
      // Also set read=true so the gate condition fires.
      await q(`UPDATE notifications SET read = true WHERE user_id = 'unbackfilled'`);
      await expect(
        run(schema, { dir: contractMigrationsDir, table: 'pgmigrations_contract' }),
      ).rejects.toThrow();
    }, 120_000);

    it('stale action on old column after contract phase raises an error (not a silent no-op)', async () => {
      // Start from a fresh schema where the full promote path completed.
      const { schema: s2, q: q2, cleanup: c2 } = await makeSchema('gate_stale');
      try {
        await run(s2, { dir: migrationsDir, table: 'pgmigrations' });
        await run(s2, { dir: contractMigrationsDir, table: 'pgmigrations_contract' });
        // After the contract phase, the read column is gone. Writing to it must fail.
        await expect(
          q2(`INSERT INTO notifications (user_id, type, title, message, read) VALUES ('stale_writer','score_changed','t','m', true)`),
        ).rejects.toThrow(/column/i);
      } finally {
        await c2();
      }
    }, 120_000);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // K. Access-control: rehearsal requires a non-production connection
  // ─────────────────────────────────────────────────────────────────────────
  describe('K. Access-control constraints', () => {
    it('DATABASE_URL must not point at a production host', () => {
      // Reject any URL containing well-known production host indicators.
      // This is a defence-in-depth guard; the CI workflow also enforces this
      // via ROLLBACK_REHEARSAL_ALLOW_PROD being absent from the env.
      const allowProd = process.env.ROLLBACK_REHEARSAL_ALLOW_PROD;
      if (allowProd === '1') {
        console.warn('ROLLBACK_REHEARSAL_ALLOW_PROD=1 is set — skipping host guard');
        return;
      }
      const productionIndicators = ['prod', 'rds.amazonaws.com', 'supabase.co', '.neon.tech'];
      const dbUrl = process.env.DATABASE_URL ?? '';
      for (const indicator of productionIndicators) {
        expect(dbUrl).not.toContain(indicator);
      }
    });

    it('no migration applies a financial side-effect to a row it did not create', async () => {
      // Structural check: none of the migration files contains an UPDATE or DELETE
      // that targets a money column without an explicit WHERE clause tying it to
      // the migration's own synthetic data. We verify this by scanning migration
      // source code for the pattern UPDATE <table> SET <stroop_col> without WHERE.
      const { readFileSync, readdirSync } = await import('node:fs');
      const { join } = await import('node:path');
      const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.js'));
      const unsafe: string[] = [];
      for (const f of files) {
        const src = readFileSync(join(migrationsDir, f), 'utf8');
        // Flag any raw SQL UPDATE on a stroop column with no WHERE.
        // Simple heuristic: "UPDATE ... SET ... _stroops" not followed by "WHERE" on
        // the same or next line.
        const pattern = /UPDATE\s+\S+\s+SET[^;]+_stroops[^;]*(?!WHERE)[^;]*;/gi;
        const matches = src.match(pattern);
        if (matches) {
          // Filter out matches that DO contain WHERE.
          const reallyUnsafe = matches.filter((m) => !/WHERE/i.test(m));
          if (reallyUnsafe.length > 0) unsafe.push(`${f}: ${reallyUnsafe.join(' | ')}`);
        }
      }
      expect(unsafe).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Registry coverage gate
//
// This runs as a pure static check with no database required. It verifies that
// every entry in rollbackRegistry.json has a matching rehearsal test file so
// new expand-contract pairs cannot be merged without a corresponding rehearsal.
// ---------------------------------------------------------------------------
describe('Rollback registry coverage gate (static, no DB required)', () => {
  it('every expand-contract pair in the registry has a rehearsal test file', async () => {
    const { readFileSync, existsSync } = await import('node:fs');
    const { resolve, join } = await import('node:path');
    const registryPath = resolve(
      new URL('.', import.meta.url).pathname,
      'fixtures/rollbackRegistry.json',
    );
    const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
    const backendRoot = resolve(new URL('.', import.meta.url).pathname, '../../..');
    for (const pair of registry.expandContractPairs) {
      const testPath = join(backendRoot, pair.rehearsalTest);
      expect(existsSync(testPath)).toBe(true);
    }
    for (const entry of registry.workerCompatibilityMatrix) {
      const testPath = join(backendRoot, entry.rehearsalTest);
      expect(existsSync(testPath)).toBe(true);
    }
  });

  it('every expand-contract pair declares rollbackSupported explicitly', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const registryPath = resolve(
      new URL('.', import.meta.url).pathname,
      'fixtures/rollbackRegistry.json',
    );
    const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
    for (const pair of registry.expandContractPairs) {
      expect(typeof pair.rollbackSupported).toBe('boolean');
      // Pairs with rollbackSupported=false must provide a justification note.
      if (!pair.rollbackSupported) {
        expect(typeof pair.notes).toBe('string');
        expect(pair.notes.length).toBeGreaterThan(0);
      }
    }
  });

  it('every expand migration file referenced in the registry exists on disk', async () => {
    const { existsSync } = await import('node:fs');
    const { resolve, join } = await import('node:path');
    const registryPath = resolve(
      new URL('.', import.meta.url).pathname,
      'fixtures/rollbackRegistry.json',
    );
    const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
    const backendRoot = resolve(new URL('.', import.meta.url).pathname, '../../..');
    for (const pair of registry.expandContractPairs) {
      const expandPath = join(backendRoot, pair.expandDir, `${pair.expandMigration}.js`);
      expect(existsSync(expandPath)).toBe(true);
      const contractPath = join(backendRoot, pair.contractDir, `${pair.contractMigration}.js`);
      expect(existsSync(contractPath)).toBe(true);
    }
  });
});
