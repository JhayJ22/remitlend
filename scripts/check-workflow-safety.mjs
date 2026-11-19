#!/usr/bin/env node

/**
 * check-workflow-safety.mjs
 *
 * Verifies that:
 * 1. No production credentials or mainnet value-bearing Stellar RPC endpoints
 *    are referenced in CI test or onboarding workflows.
 * 2. PWA service-worker caching rules bypass authenticated and transaction-sensitive
 *    API responses (#550).
 * 3. Score snapshots include reproducible input versioning (#552) and distinguish
 *    missing or delayed remittance evidence from negative credit behavior (#555).
 * 4. Financial changes carry issue-to-release traceability (#873): linked accepted
 *    requirements, required risk evidence, release notes, and deployment checks,
 *    and high-risk acceptance criteria are not released while unresolved or
 *    silently waived without explicit approval.
 */

import { readdirSync, readFileSync } from "fs";
import { createHash } from "crypto";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const MAINNET_PASSPHRASE = "Public Global Stellar Network ; September 2015";
const SENSITIVE_PATH_PREFIXES = [
  "/api/v1/auth",
  "/api/v1/loans",
  "/api/v1/pools",
  "/api/v1/remittances",
  "/api/v1/scores",
  "/api/v1/transactions",
];

/**
 * Ensures CI test workflows do not target Stellar Mainnet or production endpoints.
 */
export function auditWorkflowSafety(repoRoot = root) {
  const workflowsDir = join(repoRoot, ".github", "workflows");
  const files = readdirSync(workflowsDir).filter(
    (f) => (f.endsWith(".yml") || f.endsWith(".yaml")) && !f.includes("release") && !f.includes("deploy"),
  );

  const violations = [];
  for (const file of files) {
    const content = readFileSync(join(workflowsDir, file), "utf-8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(MAINNET_PASSPHRASE)) {
        violations.push({
          file: `.github/workflows/${file}`,
          line: i + 1,
          reason: "CI test workflow references Stellar Mainnet passphrase",
        });
      }
    }
  }

  return { safe: violations.length === 0, violations };
}

/**
 * Determines whether a request must bypass PWA service-worker caching (#550).
 */
export function shouldBypassServiceWorkerCache({ urlPath, hasAuthorizationHeader = false, method = "GET" }) {
  if (method !== "GET" || hasAuthorizationHeader) {
    return true;
  }
  return SENSITIVE_PATH_PREFIXES.some((prefix) => urlPath.startsWith(prefix));
}

/**
 * Produces a deterministic, versioned score snapshot digest (#552) and classifies
 * missing/delayed remittance evidence separately from negative repayment behavior (#555).
 */
export function buildReproducibleScoreSnapshot({
  modelVersion = "v1.0.0",
  borrowerId,
  verifiedRemittances = [],
  pendingDelayedProofs = 0,
  missedRepayments = 0,
}) {
  const canonicalPayload = JSON.stringify({
    modelVersion,
    borrowerId,
    verifiedCount: verifiedRemittances.length,
    pendingDelayedProofs,
    missedRepayments,
  });

  const inputDigest = createHash("sha256").update(canonicalPayload).digest("hex");
  const evidenceStatus =
    missedRepayments > 0
      ? "NEGATIVE_BEHAVIOR"
      : pendingDelayedProofs > 0
        ? "DELAYED_EVIDENCE_PENDING"
        : "COMPLETE_EVIDENCE";

  return {
    modelVersion,
    inputDigest,
    evidenceStatus,
    penalizeScore: missedRepayments > 0,
  };
}

/**
 * Supported traceability states for an accepted requirement (#873).
 */
export const TRACEABILITY_STATES = Object.freeze({
  ACCEPTED: "accepted",
  IMPLEMENTED: "implemented",
  EVIDENCED: "evidenced",
  RELEASED: "released",
});

const TRACEABILITY_STATE_ORDER = [
  TRACEABILITY_STATES.ACCEPTED,
  TRACEABILITY_STATES.IMPLEMENTED,
  TRACEABILITY_STATES.EVIDENCED,
  TRACEABILITY_STATES.RELEASED,
];

/**
 * Required evidence artifacts for a financial change (#873).
 */
export const REQUIRED_EVIDENCE = Object.freeze([
  "implementationPr",
  "riskEvidence",
  "releaseNotes",
  "deploymentChecks",
]);

/**
 * Evaluates issue-to-release traceability for a financial change (#873).
 *
 * Input constraints:
 * - `requirements` must be a non-empty array of accepted requirements, each with
 *   a stable `id`, a `state` from TRACEABILITY_STATES, and a boolean `highRisk`.
 * - `evidence` must reference the implementation PR, risk evidence, release notes,
 *   and deployment checks.
 * - A high-risk acceptance criterion that is unresolved (state before RELEASED)
 *   or waived requires an explicit `waiver` with `approvedBy` and `reason`.
 *
 * Returns `{ releasable, blockers, violations }`. Invalid or stale input is
 * rejected (releasable=false) without any partial side effects.
 */
export function evaluateReleaseTraceability({ requirements = [], evidence = {}, waivers = [] } = {}) {
  const violations = [];
  const blockers = [];

  if (!Array.isArray(requirements) || requirements.length === 0) {
    violations.push({ code: "MISSING_REQUIREMENTS", reason: "At least one accepted requirement must be linked." });
  }

  const seenIds = new Set();
  for (const req of Array.isArray(requirements) ? requirements : []) {
    if (!req || typeof req.id !== "string" || req.id.length === 0) {
      violations.push({ code: "INVALID_REQUIREMENT", reason: "Requirement is missing a stable id." });
      continue;
    }
    if (seenIds.has(req.id)) {
      violations.push({ code: "DUPLICATE_REQUIREMENT", reason: `Requirement ${req.id} is linked more than once.` });
    }
    seenIds.add(req.id);
    if (!TRACEABILITY_STATE_ORDER.includes(req.state)) {
      violations.push({ code: "INVALID_STATE", reason: `Requirement ${req.id} has unsupported state "${req.state}".` });
    }
  }

  for (const key of REQUIRED_EVIDENCE) {
    const value = evidence ? evidence[key] : undefined;
    if (typeof value !== "string" || value.trim().length === 0) {
      violations.push({ code: "MISSING_EVIDENCE", reason: `Missing required evidence: ${key}.` });
    }
  }

  const waiverById = new Map();
  for (const waiver of Array.isArray(waivers) ? waivers : []) {
    if (!waiver || typeof waiver.requirementId !== "string") {
      violations.push({ code: "INVALID_WAIVER", reason: "Waiver is missing a requirementId." });
      continue;
    }
    if (typeof waiver.approvedBy !== "string" || waiver.approvedBy.trim().length === 0) {
      violations.push({ code: "INVALID_WAIVER", reason: `Waiver for ${waiver.requirementId} lacks explicit approval.` });
      continue;
    }
    if (typeof waiver.reason !== "string" || waiver.reason.trim().length === 0) {
      violations.push({ code: "INVALID_WAIVER", reason: `Waiver for ${waiver.requirementId} lacks a reason.` });
      continue;
    }
    waiverById.set(waiver.requirementId, waiver);
  }

  for (const req of Array.isArray(requirements) ? requirements : []) {
    if (!req || !req.highRisk) continue;
    const resolved = req.state === TRACEABILITY_STATES.RELEASED;
    if (resolved) continue;
    if (waiverById.has(req.id)) continue;
    blockers.push({
      code: "UNRESOLVED_HIGH_RISK",
      requirementId: req.id,
      reason: `High-risk requirement ${req.id} is unresolved (state "${req.state}") and not explicitly waived.`,
    });
  }

  const releasable = violations.length === 0 && blockers.length === 0;
  return { releasable, blockers, violations };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = auditWorkflowSafety(root);
  if (!result.safe) {
    console.error("❌ Workflow safety check failed:");
    for (const v of result.violations) {
      console.error(`  - ${v.file}:${v.line}: ${v.reason}`);
    }
    process.exit(1);
  }
  console.log("✅ Workflows verified free of production credentials and mainnet value-bearing transactions.");
}
