import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import {
  loadCoverageMap,
  validateCoverageMap,
  checkFinancialWorkflowCoverage,
} from '../check-financial-workflow-coverage.mjs';

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'fwc-'));
  return root;
}

function writeFile(root, relPath, contents) {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents, 'utf8');
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

const VALID_MAP = {
  version: 1,
  workflows: [
    {
      id: 'borrower.loan-origination',
      description: 'Borrower requests and receives a loan',
      layers: {
        contract: ['contracts/loan/src/lib.rs'],
        backend: ['backend/src/loans/origination.ts'],
        frontend: ['frontend/src/pages/LoanApply.tsx'],
        e2e: ['e2e/loan-origination.spec.ts'],
      },
    },
    {
      id: 'lender.disbursement',
      description: 'Lender disburses approved loan',
      layers: {
        contract: ['contracts/loan/src/lib.rs'],
        backend: ['backend/src/loans/disbursement.ts'],
        frontend: ['frontend/src/pages/LenderDashboard.tsx'],
        e2e: ['e2e/disbursement.spec.ts'],
      },
    },
  ],
};

function seedValidRepo(root) {
  writeFile(root, 'financial-workflow-coverage.json', JSON.stringify(VALID_MAP, null, 2));
  for (const wf of VALID_MAP.workflows) {
    for (const files of Object.values(wf.layers)) {
      for (const f of files) {
        writeFile(root, f, '// placeholder\n');
      }
    }
  }
}

test('success path: valid coverage map passes validation', () => {
  const root = makeRepo();
  try {
    seedValidRepo(root);
    const map = loadCoverageMap(root);
    const result = validateCoverageMap(map, root);
    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
    assert.equal(result.workflowsChecked, VALID_MAP.workflows.length);
  } finally {
    cleanup(root);
  }
});

test('boundary: empty change set does not require evidence', () => {
  const root = makeRepo();
  try {
    seedValidRepo(root);
    const result = checkFinancialWorkflowCoverage({
      root,
      changedFiles: [],
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.affectedWorkflows, []);
  } finally {
    cleanup(root);
  }
});

test('boundary: unrelated change set does not require evidence', () => {
  const root = makeRepo();
  try {
    seedValidRepo(root);
    const result = checkFinancialWorkflowCoverage({
      root,
      changedFiles: ['docs/README.md', 'frontend/src/components/Button.tsx'],
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.affectedWorkflows, []);
  } finally {
    cleanup(root);
  }
});

test('failure: changed financial path without required evidence fails', () => {
  const root = makeRepo();
  try {
    seedValidRepo(root);
    const result = checkFinancialWorkflowCoverage({
      root,
      changedFiles: ['backend/src/loans/origination.ts'],
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.length > 0);
    const joined = result.errors.join('\n');
    assert.match(joined, /borrower\.loan-origination/);
    assert.match(joined, /e2e/);
    assert.deepEqual(result.affectedWorkflows, ['borrower.loan-origination']);
  } finally {
    cleanup(root);
  }
});

test('failure: changed financial path with evidence passes', () => {
  const root = makeRepo();
  try {
    seedValidRepo(root);
    const result = checkFinancialWorkflowCoverage({
      root,
      changedFiles: [
        'backend/src/loans/origination.ts',
        'e2e/loan-origination.spec.ts',
      ],
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.affectedWorkflows, ['borrower.loan-origination']);
  } finally {
    cleanup(root);
  }
});

test('failure: missing referenced test file is reported as dependency failure', () => {
  const root = makeRepo();
  try {
    seedValidRepo(root);
    rmSync(join(root, 'e2e/loan-origination.spec.ts'));
    const map = loadCoverageMap(root);
    const result = validateCoverageMap(map, root);
    assert.equal(result.ok, false);
    const joined = result.errors.join('\n');
    assert.match(joined, /e2e\/loan-origination\.spec\.ts/);
    assert.match(joined, /missing|not found/i);
  } finally {
    cleanup(root);
  }
});

test('failure: missing coverage map file is reported', () => {
  const root = makeRepo();
  try {
    assert.throws(() => loadCoverageMap(root), /financial-workflow-coverage\.json/);
  } finally {
    cleanup(root);
  }
});

test('failure: workflow missing a required layer is rejected', () => {
  const root = makeRepo();
  try {
    const broken = JSON.parse(JSON.stringify(VALID_MAP));
    delete broken.workflows[0].layers.e2e;
    writeFile(root, 'financial-workflow-coverage.json', JSON.stringify(broken, null, 2));
    for (const wf of broken.workflows) {
      for (const files of Object.values(wf.layers)) {
        for (const f of files) {
          writeFile(root, f, '// placeholder\n');
        }
      }
    }
    const map = loadCoverageMap(root);
    const result = validateCoverageMap(map, root);
    assert.equal(result.ok, false);
    const joined = result.errors.join('\n');
    assert.match(joined, /borrower\.loan-origination/);
    assert.match(joined, /e2e/);
  } finally {
    cleanup(root);
  }
});