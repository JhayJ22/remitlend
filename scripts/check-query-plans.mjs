#!/usr/bin/env node
// Query plan monitoring for critical backend queries (issue #821).
//
// Runs EXPLAIN (ANALYZE, FORMAT JSON) against a representative set of critical
// queries and fails when any plan contains a Seq Scan on a table whose
// estimated row count exceeds SEQ_SCAN_ROW_THRESHOLD (default 1000).
//
// Usage:
//   DATABASE_URL=postgres://... node scripts/check-query-plans.mjs
//
// If DATABASE_URL is not set the script exits 0 with a notice so it can be
// wired into CI without a database until one is provisioned.

import { Client } from 'pg';

const SEQ_SCAN_ROW_THRESHOLD = Number(process.env.SEQ_SCAN_ROW_THRESHOLD || 1000);

// At least 8 critical queries. Each entry is a name + SQL statement.
const CRITICAL_QUERIES = [
  {
    name: 'loan list (by borrower)',
    sql: 'SELECT * FROM loans WHERE borrower_id = $1 ORDER BY created_at DESC LIMIT 50',
    params: ['00000000-0000-0000-0000-000000000000'],
  },
  {
    name: 'loan list (by status)',
    sql: 'SELECT * FROM loans WHERE status = $1 ORDER BY created_at DESC LIMIT 50',
    params: ['active'],
  },
  {
    name: 'score lookup (by borrower)',
    sql: 'SELECT * FROM credit_scores WHERE borrower_id = $1 ORDER BY created_at DESC LIMIT 1',
    params: ['00000000-0000-0000-0000-000000000000'],
  },
  {
    name: 'score lookup (by id)',
    sql: 'SELECT * FROM credit_scores WHERE id = $1',
    params: ['00000000-0000-0000-0000-000000000000'],
  },
  {
    name: 'notification filter (by user + read)',
    sql: 'SELECT * FROM notifications WHERE user_id = $1 AND read = false ORDER BY created_at DESC LIMIT 50',
    params: ['00000000-0000-0000-0000-000000000000'],
  },
  {
    name: 'notification filter (by type)',
    sql: 'SELECT * FROM notifications WHERE type = $1 ORDER BY created_at DESC LIMIT 50',
    params: ['loan_update'],
  },
  {
    name: 'event indexer checkpoint (latest)',
    sql: 'SELECT * FROM event_indexer_checkpoints ORDER BY ledger DESC LIMIT 1',
    params: [],
  },
  {
    name: 'event indexer checkpoint (by contract)',
    sql: 'SELECT * FROM event_indexer_checkpoints WHERE contract_id = $1 ORDER BY ledger DESC LIMIT 1',
    params: ['00000000-0000-0000-0000-000000000000'],
  },
  {
    name: 'loan list (by contract)',
    sql: 'SELECT * FROM loans WHERE contract_id = $1 ORDER BY created_at DESC LIMIT 50',
    params: ['00000000-0000-0000-0000-000000000000'],
  },
];

function collectSeqScans(node, out) {
  if (!node || typeof node !== 'object') return;
  if (node['Node Type'] === 'Seq Scan') {
    out.push({
      relation: node['Relation Name'] || '(unknown)',
      planRows: Number(node['Plan Rows'] || 0),
      filter: node['Filter'] || null,
    });
  }
  for (const child of node['Plans'] || []) {
    collectSeqScans(child, out);
  }
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.log('DATABASE_URL not set; skipping query plan check.');
    return;
  }

  const client = new Client({ connectionString });
  await client.connect();

  const failures = [];
  try {
    for (const query of CRITICAL_QUERIES) {
      const explainSql = `EXPLAIN (ANALYZE, FORMAT JSON) ${query.sql}`;
      let result;
      try {
        result = await client.query(explainSql, query.params);
      } catch (err) {
        failures.push({ query, error: err.message });
        continue;
      }

      const plan = result.rows[0]['QUERY PLAN'];
      const root = Array.isArray(plan) ? plan[0].Plan : plan.Plan;
      const seqScans = [];
      collectSeqScans(root, seqScans);

      const offending = seqScans.filter((s) => s.planRows > SEQ_SCAN_ROW_THRESHOLD);
      if (offending.length > 0) {
        failures.push({ query, seqScans: offending, plan: JSON.stringify(plan, null, 2) });
      } else {
        console.log(`OK   ${query.name}`);
      }
    }
  } finally {
    await client.end();
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`\nFAIL ${failure.query.name}`);
      console.error(`  SQL: ${failure.query.sql}`);
      if (failure.error) {
        console.error(`  Error: ${failure.error}`);
        continue;
      }
      for (const scan of failure.seqScans) {
        console.error(
          `  Seq Scan on "${scan.relation}" (~${scan.planRows} rows > ${SEQ_SCAN_ROW_THRESHOLD})`,
        );
      }
      console.error('  Plan:');
      console.error(failure.plan);
    }
    console.error(`\n${failures.length} critical query plan(s) failed the index usage check.`);
    process.exit(1);
  }

  console.log(`\nAll ${CRITICAL_QUERIES.length} critical query plans passed.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
