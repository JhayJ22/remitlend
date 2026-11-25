#!/usr/bin/env node
// scripts/check-financial-workflow-coverage.mjs
//
// CI validator for the cross-layer financial workflow coverage map.
//
// Reads the coverage map (default: docs/financial-workflow-coverage.json),
// diffs the changed financial paths against it, and fails when required
// contract / backend / frontend / e2e evidence is missing.
//
// Usage:
//   node scripts/check-financial-workflow-coverage.mjs [--changed-files <file>] [--map <path>] [--root <dir>]
//
//   --changed-files <file>  Path to a newline-delimited list of changed files
//                           (e.g. produced by `git diff --name-only`). When
//                           omitted, the script falls back to reading
//                           GITHUB_BASE_REF / GITHUB_SHA or the working tree
//                           diff against origin/main.
//   --map <path>            Path to the coverage map JSON (default:
//                           docs/financial-workflow-coverage.json).
//   --root <dir>            Repository root (default: process.cwd()).
//   --help                  Print usage.
//
// Exit codes:
//   0  All changed financial paths have required evidence and test files exist.
//   1  Missing evidence, missing test files, or invalid map.
//   2  Usage / IO error.

import { readFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join, isAbsolute } from 'node:path';

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;

const DEFAULT_MAP = 'docs/financial-workflow-coverage.json';

function usage() {
  return [
    'Usage: node scripts/check-financial-workflow-coverage.mjs [options]',
    '',
    'Options:',
    '  --changed-files <file>  Newline-delimited list of changed files.',
    '  --map <path>            Coverage map JSON (default: ' + DEFAULT_MAP + ').',
    '  --root <dir>            Repository root (default: cwd).',
    '  --help                  Show this help.',
  ].join('\n');
}

function parseArgs(argv) {
  const opts = { changedFiles: null, map: DEFAULT_MAP, root: process.cwd(), help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--changed-files') {
      opts.changedFiles = argv[++i];
      if (!opts.changedFiles) throw new Error('--changed-files requires a value');
    } else if (arg.startsWith('--changed-files=')) {
      opts.changedFiles = arg.slice('--changed-files='.length);
    } else if (arg === '--map') {
      opts.map = argv[++i];
      if (!opts.map) throw new Error('--map requires a value');
    } else if (arg.startsWith('--map=')) {
      opts.map = arg.slice('--map='.length);
    } else if (arg === '--root') {
      opts.root = argv[++i];
      if (!opts.root) throw new Error('--root requires a value');
    } else if (arg.startsWith('--root=')) {
      opts.root = arg.slice('--root='.length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

function readChangedFiles(opts) {
  if (opts.changedFiles) {
    const p = isAbsolute(opts.changedFiles)
      ? opts.changedFiles
      : resolve(opts.root, opts.changedFiles);
    if (!existsSync(p)) {
      throw new Error(`Changed-files list not found: ${p}`);
    }
    return readFileSync(p, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  }

  // Fallback: derive from git. Prefer explicit base ref, then origin/main.
  const base = process.env.GITHUB_BASE_REF
    ? `origin/${process.env.GITHUB_BASE_REF}`
    : 'origin/main';
  try {
    const out = execFileSync(
      'git',
      ['diff', '--name-only', '--diff-filter=ACMR', `${base}...HEAD`],
      { cwd: opts.root, encoding: 'utf8' },
    );
    return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  } catch (err) {
    // Last resort: uncommitted changes.
    try {
      const out = execFileSync(
        'git',
        ['diff', '--name-only', '--diff-filter=ACMR', 'HEAD'],
        { cwd: opts.root, encoding: 'utf8' },
      );
      return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    } catch {
      throw new Error(
        `Unable to determine changed files (git diff failed: ${err.message}). ` +
          'Pass --changed-files <file>.',
      );
    }
  }
}

function loadMap(mapPath) {
  if (!existsSync(mapPath)) {
    throw new Error(`Coverage map not found: ${mapPath}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(mapPath, 'utf8'));
  } catch (err) {
    throw new Error(`Coverage map is not valid JSON (${mapPath}): ${err.message}`);
  }
  validateMap(parsed, mapPath);
  return parsed;
}

const REQUIRED_LAYERS = ['contract', 'backend', 'frontend', 'e2e'];

function validateMap(map, mapPath) {
  if (!map || typeof map !== 'object') {
    throw new Error(`Coverage map must be an object: ${mapPath}`);
  }
  if (!Array.isArray(map.workflows) || map.workflows.length === 0) {
    throw new Error(`Coverage map must contain a non-empty "workflows" array: ${mapPath}`);
  }
  const seen = new Set();
  for (const wf of map.workflows) {
    if (!wf || typeof wf !== 'object') {
      throw new Error(`Invalid workflow entry in ${mapPath}`);
    }
    if (!wf.id || typeof wf.id !== 'string') {
      throw new Error(`Workflow missing string "id" in ${mapPath}`);
    }
    if (seen.has(wf.id)) {
      throw new Error(`Duplicate workflow id "${wf.id}" in ${mapPath}`);
    }
    seen.add(wf.id);
    if (!Array.isArray(wf.paths) || wf.paths.length === 0) {
      throw new Error(`Workflow "${wf.id}" must declare a non-empty "paths" array`);
    }
    if (!wf.evidence || typeof wf.evidence !== 'object') {
      throw new Error(`Workflow "${wf.id}" must declare an "evidence" object`);
    }
    for (const layer of REQUIRED_LAYERS) {
      const entry = wf.evidence[layer];
      if (!entry || !Array.isArray(entry.tests) || entry.tests.length === 0) {
        throw new Error(
          `Workflow "${wf.id}" is missing required "${layer}" evidence (tests array)`,
        );
      }
    }
  }
}

// Convert a glob-ish path pattern (supports ** and *) into a RegExp.
function patternToRegExp(pattern) {
  let re = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // ** matches across path separators
        re += '.*';
        i += 1;
        // swallow a following slash so "**/x" also matches "x"
        if (pattern[i + 1] === '/') i += 1;
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else if ('\\^$+.()|{}[]'.includes(ch)) {
      re += `\\${ch}`;
    } else {
      re += ch;
    }
  }
  re += '$';
  return new RegExp(re);
}

function normalizePath(p) {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

function matchesAny(file, patterns) {
  const norm = normalizePath(file);
  return patterns.some((pat) => patternToRegExp(normalizePath(pat)).test(norm));
}

function fileExists(root, relPath) {
  const abs = isAbsolute(relPath) ? relPath : join(root, relPath);
  try {
    return statSync(abs).isFile();
  } catch {
    return false;
  }
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`error: ${err.message}`);
    console.error(usage());
    process.exit(EXIT_USAGE);
  }

  if (opts.help) {
    console.log(usage());
    process.exit(EXIT_OK);
  }

  const root = resolve(opts.root);
  const mapPath = isAbsolute(opts.map) ? opts.map : resolve(root, opts.map);

  let map;
  let changedFiles;
  try {
    map = loadMap(mapPath);
    changedFiles = readChangedFiles({ ...opts, root });
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(EXIT_USAGE);
  }

  console.log('Financial workflow coverage check');
  console.log(`  root:          ${root}`);
  console.log(`  map:           ${mapPath}`);
  console.log(`  changed files: ${changedFiles.length}`);

  // Determine which workflows are touched by the changed files.
  const touched = [];
  for (const wf of map.workflows) {
    const hitFiles = changedFiles.filter((f) => matchesAny(f, wf.paths));
    if (hitFiles.length > 0) {
      touched.push({ wf, hitFiles });
    }
  }

  if (touched.length === 0) {
    console.log('\nNo financial workflow paths were changed. Nothing to verify.');
    printRepro(mapPath, opts);
    process.exit(EXIT_OK);
  }

  console.log(`\nTouched workflows: ${touched.map((t) => t.wf.id).join(', ')}`);

  const failures = [];

  for (const { wf, hitFiles } of touched) {
    console.log(`\nWorkflow "${wf.id}" (${wf.title || 'untitled'})`);
    console.log(`  changed paths:`);
    for (const f of hitFiles) console.log(`    - ${f}`);

    for (const layer of REQUIRED_LAYERS) {
      const entry = wf.evidence[layer];
      const tests = entry.tests || [];
      const missing = tests.filter((t) => !fileExists(root, t));
      if (missing.length > 0) {
        for (const m of missing) {
          failures.push(
            `[${wf.id}] ${layer} evidence file missing: ${m}`,
          );
        }
        console.log(`  ${layer}: MISSING (${missing.length}/${tests.length})`);
      } else {
        console.log(`  ${layer}: ok (${tests.length} test file(s))`);
      }
    }
  }

  if (failures.length > 0) {
    console.error('\nFinancial workflow coverage FAILED:');
    for (const f of failures) console.error(`  - ${f}`);
    console.error(
      '\nUpdate the coverage map and/or add the missing tests. ' +
        'See docs/financial-workflow-coverage.md for the required evidence per layer.',
    );
    printRepro(mapPath, opts);
    process.exit(EXIT_FAIL);
  }

  console.log('\nFinancial workflow coverage OK: all required evidence present.');
  printRepro(mapPath, opts);
  process.exit(EXIT_OK);
}

function printRepro(mapPath, opts) {
  console.log('\nReproduce locally:');
  console.log(
    `  git diff --name-only origin/main...HEAD > /tmp/changed.txt`,
  );
  console.log(
    `  node scripts/check-financial-workflow-coverage.mjs --changed-files /tmp/changed.txt --map ${JSON.stringify(
      opts.map,
    )}`,
  );
  console.log(
    `  node scripts/check-financial-workflow-coverage.mjs --map ${JSON.stringify(
      opts.map,
    )}   # uses git diff against origin/main`,
  );
  console.log(`  (map resolved to: ${mapPath})`);
}

main();