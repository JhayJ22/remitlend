#!/usr/bin/env node
/**
 * scripts/check-rollback-coverage.mjs
 *
 * CI gate for issue #861: fail the release pipeline when any registered
 * expand-contract migration pair or worker-compatibility entry in
 * backend/src/__tests__/fixtures/rollbackRegistry.json does not have a
 * corresponding rehearsal test file on disk.
 *
 * Also validates the structural integrity of the registry itself:
 *   - required fields present
 *   - expand and contract migration files exist
 *   - rollbackSupported=false entries provide a justification note
 *   - no duplicate pair IDs
 *
 * Exit codes:
 *   0  all entries covered and structurally valid
 *   1  one or more coverage or integrity errors found
 *
 * Usage (from repo root):
 *   node scripts/check-rollback-coverage.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const backendRoot = join(repoRoot, 'backend');

const registryPath = join(
  backendRoot,
  'src/__tests__/fixtures/rollbackRegistry.json',
);

// ─── Load registry ──────────────────────────────────────────────────────────

if (!existsSync(registryPath)) {
  console.error(`::error::Rollback registry not found: ${registryPath}`);
  console.error('  Create backend/src/__tests__/fixtures/rollbackRegistry.json');
  process.exit(1);
}

let registry;
try {
  registry = JSON.parse(readFileSync(registryPath, 'utf8'));
} catch (e) {
  console.error(`::error::Failed to parse rollback registry: ${e.message}`);
  process.exit(1);
}

const errors = [];
const seenIds = new Set();

// ─── Validate expand-contract pairs ─────────────────────────────────────────

const pairs = registry.expandContractPairs ?? [];
if (!Array.isArray(pairs) || pairs.length === 0) {
  errors.push('expandContractPairs is missing or empty — at least one entry is required');
}

for (const pair of pairs) {
  const ctx = `expandContractPairs[${pair.id ?? '?'}]`;

  // Required fields.
  for (const field of ['id', 'expandMigration', 'contractMigration', 'expandDir', 'contractDir', 'rehearsalTest', 'rollbackSupported']) {
    if (!(field in pair)) {
      errors.push(`${ctx}: missing required field "${field}"`);
    }
  }

  // Duplicate IDs.
  if (pair.id) {
    if (seenIds.has(pair.id)) {
      errors.push(`${ctx}: duplicate id "${pair.id}"`);
    }
    seenIds.add(pair.id);
  }

  // rollbackSupported=false must have a note.
  if (pair.rollbackSupported === false) {
    if (!pair.notes || typeof pair.notes !== 'string' || pair.notes.trim().length === 0) {
      errors.push(`${ctx}: rollbackSupported=false requires a non-empty "notes" justification`);
    }
  }

  // Expand migration file on disk.
  if (pair.expandDir && pair.expandMigration) {
    const p = join(backendRoot, pair.expandDir, `${pair.expandMigration}.js`);
    if (!existsSync(p)) {
      errors.push(`${ctx}: expand migration file not found: ${p}`);
    }
  }

  // Contract migration file on disk.
  if (pair.contractDir && pair.contractMigration) {
    const p = join(backendRoot, pair.contractDir, `${pair.contractMigration}.js`);
    if (!existsSync(p)) {
      errors.push(`${ctx}: contract migration file not found: ${p}`);
    }
  }

  // Rehearsal test file on disk.
  if (pair.rehearsalTest) {
    const p = join(backendRoot, pair.rehearsalTest);
    if (!existsSync(p)) {
      errors.push(
        `${ctx}: rehearsal test file not found: ${p}\n` +
        `  Add a test at backend/${pair.rehearsalTest} covering the rollback path for "${pair.id}".`,
      );
    }
  }
}

// ─── Validate worker compatibility matrix ───────────────────────────────────

const workers = registry.workerCompatibilityMatrix ?? [];

for (const entry of workers) {
  const ctx = `workerCompatibilityMatrix[${entry.id ?? '?'}]`;

  for (const field of ['id', 'migration', 'rehearsalTest', 'rollbackSupported']) {
    if (!(field in entry)) {
      errors.push(`${ctx}: missing required field "${field}"`);
    }
  }

  if (entry.id) {
    if (seenIds.has(entry.id)) {
      errors.push(`${ctx}: duplicate id "${entry.id}"`);
    }
    seenIds.add(entry.id);
  }

  if (entry.rollbackSupported === false) {
    if (!entry.notes || typeof entry.notes !== 'string' || entry.notes.trim().length === 0) {
      errors.push(`${ctx}: rollbackSupported=false requires a non-empty "notes" justification`);
    }
  }

  if (entry.rehearsalTest) {
    const p = join(backendRoot, entry.rehearsalTest);
    if (!existsSync(p)) {
      errors.push(
        `${ctx}: rehearsal test file not found: ${p}\n` +
        `  Add a test at backend/${entry.rehearsalTest} covering worker compatibility for "${entry.id}".`,
      );
    }
  }
}

// ─── Report ─────────────────────────────────────────────────────────────────

if (errors.length > 0) {
  console.error(`\n${errors.length} rollback coverage error(s):\n`);
  for (const err of errors) {
    console.error(`  ::error::${err}`);
  }
  console.error(
    '\nFix: add the missing rehearsal test file(s) and/or update the registry.\n' +
    'Every expand-contract migration pair MUST have a passing rollback rehearsal before release.\n',
  );
  process.exit(1);
}

console.log(`Rollback coverage check passed.`);
console.log(`  Expand-contract pairs : ${pairs.length}`);
console.log(`  Worker compat entries : ${workers.length}`);
console.log(`  All rehearsal test files found and registry is structurally valid.`);
