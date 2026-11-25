/**
 * Trust-boundary change inventory and gate check (issue #856).
 *
 * Reads a list of changed file paths from stdin (one per line) or from
 * the --files flag, classifies them against the trust-boundary pattern map,
 * and exits non-zero if:
 *   - any boundary is touched that does not have a current approved review
 *     in the THREAT_MODEL_REVIEW_STATUS_FILE, AND
 *   - THREAT_MODEL_GATE_OVERRIDE is not set to "true" in the environment.
 *
 * Usage (CI):
 *   git diff --name-only origin/main... | node scripts/check-trust-boundaries.mjs
 *
 * Usage (manual):
 *   node scripts/check-trust-boundaries.mjs --files backend/src/routes/adminRoutes.ts
 *
 * The script writes a machine-readable JSON inventory to stdout so it can be
 * consumed by the calling workflow step.
 *
 * Review status is read from docs/THREAT_MODEL_REVIEW_STATUS.json (committed
 * in the same PR that approves the review, updated by the admin API).
 */

import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

// ── Boundary pattern map (mirrors threatModelRefreshService.ts) ───────────────

const BOUNDARY_FILE_PATTERNS = {
  wallet: [
    'backend/src/services/authService',
    'backend/src/middleware/jwtAuth',
    'backend/src/services/challengeNonceService',
    'frontend/src/lib/wallet',
    'frontend/src/hooks/useWallet',
  ],
  provider: [
    'backend/src/services/soroban',
    'backend/src/config/stellar',
    'backend/src/services/piiCrypto',
    'backend/src/services/keyRotation',
    'backend/src/services/backupService',
  ],
  api: [
    'backend/src/routes/',
    'backend/src/middleware/auth',
    'backend/src/middleware/rateLimiter',
    'backend/src/schemas/',
  ],
  contract: [
    'contracts/',
    'backend/src/services/sorobanService',
    'backend/src/services/contractVerification',
    'scripts/deploy',
  ],
  infra: [
    'docker-compose',
    '.github/workflows/',
    'backend/src/db/',
    'backend/migrations/',
    'backend/src/config/',
  ],
};

// ── Review status ─────────────────────────────────────────────────────────────

const REVIEW_STATUS_FILE = path.join(REPO_ROOT, 'docs', 'THREAT_MODEL_REVIEW_STATUS.json');
const REVIEW_TTL_DAYS = 365;

function loadReviewStatus() {
  if (!existsSync(REVIEW_STATUS_FILE)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(REVIEW_STATUS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function isCurrentReview(reviewStatus, boundary) {
  const review = reviewStatus[boundary];
  if (!review || review.status !== 'approved' || !review.approved_at) return false;
  const approvedAt = new Date(review.approved_at).getTime();
  const ageMs = Date.now() - approvedAt;
  return ageMs < REVIEW_TTL_DAYS * 24 * 60 * 60 * 1000;
}

// ── File classification ───────────────────────────────────────────────────────

function classifyFiles(files) {
  const touched = new Set();
  for (const file of files) {
    for (const [boundary, patterns] of Object.entries(BOUNDARY_FILE_PATTERNS)) {
      if (patterns.some((p) => file.includes(p))) {
        touched.add(boundary);
      }
    }
  }
  return [...touched];
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Parse --files flag or read from stdin.
  const args = process.argv.slice(2);
  let files = [];

  const filesIdx = args.indexOf('--files');
  if (filesIdx !== -1) {
    files = args.slice(filesIdx + 1);
  } else {
    // Read from stdin (piped from git diff --name-only).
    const { createInterface } = await import('node:readline');
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed) files.push(trimmed);
    }
  }

  if (files.length === 0) {
    console.log(JSON.stringify({ touched_boundaries: [], gate_results: [], all_passed: true }));
    process.exit(0);
  }

  const touchedBoundaries = classifyFiles(files);

  if (touchedBoundaries.length === 0) {
    console.log(JSON.stringify({
      touched_boundaries: [],
      gate_results: [],
      all_passed: true,
      message: 'No trust-boundary files changed.',
    }));
    process.exit(0);
  }

  const reviewStatus = loadReviewStatus();
  const override = process.env.THREAT_MODEL_GATE_OVERRIDE === 'true';

  const gateResults = touchedBoundaries.map((boundary) => {
    const current = isCurrentReview(reviewStatus, boundary);
    const review = reviewStatus[boundary] ?? null;
    return {
      boundary,
      passed: current || override,
      forced: override && !current,
      review: review ? { id: review.id, approved_at: review.approved_at } : null,
      reason: current
        ? `Current approved review exists (approved: ${review?.approved_at})`
        : override
          ? `THREAT_MODEL_GATE_OVERRIDE=true — gate bypassed (audit required)`
          : `No approved threat-model review for boundary '${boundary}' within the last ${REVIEW_TTL_DAYS} days. ` +
            `Run POST /admin/threat-model/reviews and /approve, then update docs/THREAT_MODEL_REVIEW_STATUS.json.`,
    };
  });

  const allPassed = gateResults.every((r) => r.passed);

  const inventory = {
    changed_files: files,
    touched_boundaries: touchedBoundaries,
    gate_results: gateResults,
    all_passed: allPassed,
    override_active: override,
  };

  // Print the inventory as JSON (consumed by CI step outputs).
  console.log(JSON.stringify(inventory, null, 2));

  if (!allPassed) {
    console.error('\n[trust-boundary-gate] BLOCKED — required threat-model reviews missing:');
    for (const r of gateResults.filter((x) => !x.passed)) {
      console.error(`  ✗ ${r.boundary}: ${r.reason}`);
    }
    process.exit(1);
  }

  console.error('\n[trust-boundary-gate] All touched boundaries have current reviews.');
  process.exit(0);
}

main().catch((err) => {
  console.error('[trust-boundary-gate] Unexpected error:', err);
  process.exit(1);
});
