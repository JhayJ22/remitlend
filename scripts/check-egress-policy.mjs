#!/usr/bin/env node

/**
 * check-egress-policy.mjs (#784)
 *
 * Detects drift between the webhook egress rules enforced in code
 * (WEBHOOK_EGRESS_RULES in backend/src/services/webhookEgress.ts) and the
 * policy documented in docs/EGRESS-POLICY.md, and verifies that every
 * webhook delivery path runs destination validation before dispatch.
 *
 * Exits with code 1 on any drift.
 *
 * Usage:
 *   node scripts/check-egress-policy.mjs
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf-8");

const egressSrc = read("backend/src/services/webhookEgress.ts");
const doc = read("docs/EGRESS-POLICY.md");
const errors = [];

const rulesMatch = egressSrc.match(/export const WEBHOOK_EGRESS_RULES = \{([\s\S]*?)\} as const;/);
if (!rulesMatch) {
  console.error("✗ WEBHOOK_EGRESS_RULES not found in backend/src/services/webhookEgress.ts");
  process.exit(1);
}
const rules = rulesMatch[1];

function listOf(key) {
  const m = rules.match(new RegExp(`${key}:\\s*\\[([\\s\\S]*?)\\]`));
  return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
}

const cidrs = listOf("blockedIpv4Cidrs");
const suffixes = listOf("blockedHostnameSuffixes");
const protocols = listOf("allowedProtocols");
const allowlistEnv = rules.match(/allowlistEnvVar:\s*'([^']+)'/)?.[1];

const webhookSection = doc.split(/^### Webhook destinations/m)[1]?.split(/^#{2,3} /m)[0];
if (!webhookSection) {
  errors.push('docs/EGRESS-POLICY.md is missing the "### Webhook destinations" section');
} else {
  for (const cidr of cidrs) {
    if (!webhookSection.includes(`\`${cidr}\``)) errors.push(`blocked CIDR ${cidr} not documented`);
  }
  for (const suffix of suffixes) {
    if (!webhookSection.includes(`\`${suffix}\``)) errors.push(`blocked hostname ${suffix} not documented`);
  }
  if (protocols.includes("https:") && !/HTTPS/.test(webhookSection)) {
    errors.push("HTTPS requirement not documented");
  }
  if (allowlistEnv && !webhookSection.includes(allowlistEnv)) {
    errors.push(`allowlist env var ${allowlistEnv} not documented`);
  }
  if (!webhookSection.includes("EgressPolicyViolation")) {
    errors.push("EgressPolicyViolation error not documented");
  }
  // Every CIDR documented must also be enforced (catches stale docs).
  for (const m of webhookSection.matchAll(/`(\d+\.\d+\.\d+\.\d+\/\d+)`/g)) {
    if (!cidrs.includes(m[1])) errors.push(`documented CIDR ${m[1]} is not enforced in code`);
  }
}

// Delivery paths must validate the destination before sending.
const deliveryPaths = {
  "backend/src/services/webhookService.ts": /validateWebhookUrl\(/,
  "backend/src/services/webhookDeliveryService.ts": /sendWebhookRequest\(/,
};
for (const [file, pattern] of Object.entries(deliveryPaths)) {
  if (!pattern.test(read(file))) errors.push(`${file} does not run webhook egress validation`);
}

if (errors.length > 0) {
  console.error("✗ Webhook egress policy drift detected:");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(
  `✓ Webhook egress policy in sync (${cidrs.length} CIDRs, ${suffixes.length} hostname rules, delivery paths validated)`,
);
