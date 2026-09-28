#!/usr/bin/env node
/**
 * scripts/check-contract-drift.js
 *
 * Compares the committed api.generated.ts against a live OpenAPI spec to
 * detect breaking changes. Called by `npm run validate:api-contract`.
 *
 * Usage:
 *   node scripts/check-contract-drift.js [--fail-on-breaking]
 *
 * Options:
 *   --fail-on-breaking   Exit with code 1 if breaking schema changes are found.
 *
 * Environment:
 *   OPENAPI_SPEC_URL     Backend OpenAPI spec URL (default: http://localhost:3001/docs.json)
 *   OPENAPI_SPEC_FILE    Local file path to use instead of URL (takes priority)
 *
 * Exit codes:
 *   0  No drift (or backend unreachable — fails open in CI without live backend)
 *   1  Breaking changes detected AND --fail-on-breaking was passed
 */

const fs = require("fs");
const path = require("path");

const GENERATED_PATH = path.resolve(__dirname, "../src/app/types/api.generated.ts");
const SPEC_URL = process.env.OPENAPI_SPEC_URL ?? "http://localhost:3001/docs.json";
const SPEC_FILE = process.env.OPENAPI_SPEC_FILE;
const FAIL_ON_BREAKING = process.argv.includes("--fail-on-breaking");

async function fetchSpec() {
  if (SPEC_FILE) {
    const raw = fs.readFileSync(path.resolve(SPEC_FILE), "utf8");
    return JSON.parse(raw);
  }
  try {
    const res = await fetch(SPEC_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.warn(
      `[validate:api-contract] Cannot reach ${SPEC_URL}: ${err.message}. ` +
        "Skipping drift check (backend not running).",
    );
    return null;
  }
}

function extractSchemaNames(spec) {
  const schemas = spec?.components?.schemas ?? spec?.definitions ?? {};
  return new Set(Object.keys(schemas));
}

function extractGeneratedSchemaNames(generatedSource) {
  const names = new Set();
  const re = /export\s+(?:interface|type)\s+([A-Za-z][A-Za-z0-9_]*)/g;
  let m;
  while ((m = re.exec(generatedSource)) !== null) {
    if (!["paths", "operations", "components", "webhooks"].includes(m[1])) {
      names.add(m[1]);
    }
  }
  return names;
}

async function main() {
  console.log("[validate:api-contract] Checking for API contract drift…");

  if (!fs.existsSync(GENERATED_PATH)) {
    console.error(
      `[validate:api-contract] Generated file not found at ${GENERATED_PATH}. ` +
        "Run `npm run generate:api-types` first.",
    );
    if (FAIL_ON_BREAKING) process.exit(1);
    return;
  }

  const spec = await fetchSpec();
  if (!spec) {
    console.log("[validate:api-contract] Skipped (backend not reachable).");
    return;
  }

  const liveSchemas = extractSchemaNames(spec);
  const generatedSource = fs.readFileSync(GENERATED_PATH, "utf8");
  const generatedSchemas = extractGeneratedSchemaNames(generatedSource);

  const breaking = [];
  const additions = [];

  for (const name of generatedSchemas) {
    if (!liveSchemas.has(name)) {
      breaking.push(`Schema "${name}" removed or renamed in live spec`);
    }
  }
  for (const name of liveSchemas) {
    if (!generatedSchemas.has(name)) {
      additions.push(`New schema "${name}" in live spec (run generate:api-types to add)`);
    }
  }

  if (additions.length > 0) {
    console.warn("[validate:api-contract] ⚠ Additive changes (non-breaking):");
    additions.forEach((msg) => console.warn(`  + ${msg}`));
  }

  if (breaking.length > 0) {
    console.error("[validate:api-contract] ✖ Breaking changes detected:");
    breaking.forEach((msg) => console.error(`  - ${msg}`));
    if (FAIL_ON_BREAKING) {
      console.error(
        "\n[validate:api-contract] Re-run `npm run generate:api-types` and commit the result.",
      );
      process.exit(1);
    }
  } else {
    console.log("[validate:api-contract] ✓ No breaking drift detected.");
  }
}

main().catch((err) => {
  console.error("[validate:api-contract] Unexpected error:", err);
  process.exit(1);
});
