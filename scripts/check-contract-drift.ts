#!/usr/bin/env node

/**
 * Contract Drift Detection Script
 * 
 * This script compares the current OpenAPI spec with a baseline to detect
 * breaking changes that could cause frontend/backend contract drift.
 * 
 * Usage: 
 *   node scripts/check-contract-drift.js [--baseline=<path>] [--fail-on-breaking]
 */

import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";

interface ContractCheckOptions {
  baselinePath: string;
  currentSpecPath: string;
  failOnBreaking: boolean;
  outputPath: string;
}

interface BreakingChange {
  type: "breaking" | "non-breaking" | "potentially-breaking";
  path: string;
  method: string;
  description: string;
  severity: "error" | "warning" | "info";
}

async function checkContractDrift(options: ContractCheckOptions): Promise<BreakingChange[]> {
  console.log("🔍 Checking for API contract drift...");

  const baselineSpec = loadSpec(options.baselinePath);
  const currentSpec = loadSpec(options.currentSpecPath);

  const changes: BreakingChange[] = [];

  // Check paths
  changes.push(...comparePaths(baselineSpec.paths, currentSpec.paths));

  // Check components/schemas
  changes.push(...compareComponents(baselineSpec.components?.schemas, currentSpec.components?.schemas));

  // Check security schemes
  changes.push(...compareSecurity(baselineSpec.components?.securitySchemes, currentSpec.components?.securitySchemes));

  // Report results
  reportResults(changes, options);

  return changes;
}

function loadSpec(path: string): any {
  if (!existsSync(path)) {
    throw new Error(`Spec file not found: ${path}`);
  }
  return JSON.parse(readFileSync(path, "utf-8"));
}

function comparePaths(baseline: any, current: any): BreakingChange[] {
  const changes: BreakingChange[] = [];

  // Check for removed paths
  for (const path of Object.keys(baseline || {})) {
    if (!current?.[path]) {
      changes.push({
        type: "breaking",
        path,
        method: "ALL",
        description: `Endpoint removed: ${path}`,
        severity: "error",
      });
    }
  }

  // Check for changed paths
  for (const path of Object.keys(current || {})) {
    const baselinePath = baseline?.[path];
    const currentPath = current?.[path];

    if (!baselinePath) {
      // New path - non-breaking
      changes.push({
        type: "non-breaking",
        path,
        method: "ALL",
        description: `New endpoint added: ${path}`,
        severity: "info",
      });
      continue;
    }

    // Compare methods
    for (const method of Object.keys(baselinePath)) {
      if (!currentPath[method]) {
        changes.push({
          type: "breaking",
          path,
          method: method.toUpperCase(),
          description: `Method removed: ${method.toUpperCase()} ${path}`,
          severity: "error",
        });
      } else {
        // Compare parameters
        changes.push(...compareParameters(
          baselinePath[method]?.parameters,
          currentPath[method]?.parameters,
          path,
          method.toUpperCase()
        ));

        // Compare responses
        changes.push(...compareResponses(
          baselinePath[method]?.responses,
          currentPath[method]?.responses,
          path,
          method.toUpperCase()
        ));

        // Compare request body
        changes.push(...compareRequestBody(
          baselinePath[method]?.requestBody,
          currentPath[method]?.requestBody,
          path,
          method.toUpperCase()
        ));
      }
    }

    // Check for new methods
    for (const method of Object.keys(currentPath)) {
      if (!baselinePath[method]) {
        changes.push({
          type: "non-breaking",
          path,
          method: method.toUpperCase(),
          description: `New method added: ${method.toUpperCase()} ${path}`,
          severity: "info",
        });
      }
    }
  }

  return changes;
}

function compareParameters(baseline: any[], current: any[], path: string, method: string): BreakingChange[] {
  const changes: BreakingChange[] = [];

  const baselineParams = baseline || [];
  const currentParams = current || [];

  // Check for removed required parameters
  for (const param of baselineParams) {
    if (param.required) {
      const found = currentParams.find(p => p.name === param.name && p.in === param.in);
      if (!found) {
        changes.push({
          type: "breaking",
          path,
          method,
          description: `Required parameter removed: ${param.in}.${param.name}`,
          severity: "error",
        });
      }
    }
  }

  // Check for changed parameter types
  for (const param of baselineParams) {
    const found = currentParams.find(p => p.name === param.name && p.in === param.in);
    if (found && param.schema && found.schema) {
      const typeChanges = compareSchemas(param.schema, found.schema, `${path} ${method} param ${param.name}`);
      changes.push(...typeChanges);
    }
  }

  return changes;
}

function compareResponses(baseline: any, current: any, path: string, method: string): BreakingChange[] {
  const changes: BreakingChange[] = [];

  if (!baseline || !current) return changes;

  // Check for removed success responses
  for (const statusCode of Object.keys(baseline)) {
    if (statusCode.startsWith("2") && !current[statusCode]) {
      changes.push({
        type: "breaking",
        path,
        method,
        description: `Success response removed: ${statusCode}`,
        severity: "error",
      });
    }
  }

  // Check for changed response schemas
  for (const statusCode of Object.keys(baseline)) {
    if (current[statusCode]) {
      const baselineContent = baseline[statusCode]?.content?.["application/json"]?.schema;
      const currentContent = current[statusCode]?.content?.["application/json"]?.schema;
      
      if (baselineContent && currentContent) {
        const schemaChanges = compareSchemas(
          baselineContent,
          currentContent,
          `${path} ${method} response ${statusCode}`
        );
        changes.push(...schemaChanges);
      }
    }
  }

  return changes;
}

function compareRequestBody(baseline: any, current: any, path: string, method: string): BreakingChange[] {
  const changes: BreakingChange[] = [];

  if (!baseline) return changes; // No baseline request body

  if (!current) {
    changes.push({
      type: "breaking",
      path,
      method,
      description: "Request body removed",
      severity: "error",
    });
    return changes;
  }

  const baselineContent = baseline.content?.["application/json"]?.schema;
  const currentContent = current.content?.["application/json"]?.schema;

  if (baselineContent && currentContent) {
    const schemaChanges = compareSchemas(
      baselineContent,
      currentContent,
      `${path} ${method} request body`
    );
    changes.push(...schemaChanges);
  }

  // Check required fields
  if (baseline.required && !current.required) {
    changes.push({
      type: "breaking",
      path,
      method,
      description: "Request body required flag removed",
      severity: "error",
    });
  }

  return changes;
}

function compareComponents(baseline: any, current: any): BreakingChange[] {
  const changes: BreakingChange[] = [];

  if (!baseline) return changes;

  // Check for removed schemas
  for (const schemaName of Object.keys(baseline)) {
    if (!current?.[schemaName]) {
      changes.push({
        type: "breaking",
        path: `#/components/schemas/${schemaName}`,
        method: "SCHEMA",
        description: `Schema removed: ${schemaName}`,
        severity: "error",
      });
    }
  }

  // Check for changed schemas
  for (const schemaName of Object.keys(baseline)) {
    if (current?.[schemaName]) {
      const schemaChanges = compareSchemas(
        baseline[schemaName],
        current[schemaName],
        `components/schemas/${schemaName}`
      );
      changes.push(...schemaChanges);
    }
  }

  return changes;
}

function compareSchemas(baseline: any, current: any, context: string): BreakingChange[] {
  const changes: BreakingChange[] = [];

  // Handle $ref
  if (baseline.$ref || current.$ref) {
    if (baseline.$ref !== current.$ref) {
      changes.push({
        type: "potentially-breaking",
        path: context,
        method: "SCHEMA",
        description: `Schema reference changed: ${baseline.$ref} -> ${current.$ref}`,
        severity: "warning",
      });
    }
    return changes;
  }

  // Compare required fields
  const baselineRequired = baseline.required || [];
  const currentRequired = current.required || [];

  for (const req of baselineRequired) {
    if (!currentRequired.includes(req)) {
      changes.push({
        type: "breaking",
        path: context,
        method: "SCHEMA",
        description: `Required field removed: ${req}`,
        severity: "error",
      });
    }
  }

  // Compare properties
  const baselineProps = baseline.properties || {};
  const currentProps = current.properties || {};

  for (const propName of Object.keys(baselineProps)) {
    if (!currentProps[propName]) {
      changes.push({
        type: "breaking",
        path: context,
        method: "SCHEMA",
        description: `Property removed: ${propName}`,
        severity: "error",
      });
    } else {
      // Recursively compare property schemas
      const propChanges = compareSchemas(
        baselineProps[propName],
        currentProps[propName],
        `${context}.${propName}`
      );
      changes.push(...propChanges);
    }
  }

  // Check for new required fields (potentially breaking)
  for (const req of currentRequired) {
    if (!baselineRequired.includes(req)) {
      changes.push({
        type: "potentially-breaking",
        path: context,
        method: "SCHEMA",
        description: `New required field added: ${req}`,
        severity: "warning",
      });
    }
  }

  return changes;
}

function compareSecurity(baseline: any, current: any): BreakingChange[] {
  const changes: BreakingChange[] = [];

  if (!baseline) return changes;

  for (const scheme of Object.keys(baseline)) {
    if (!current?.[scheme]) {
      changes.push({
        type: "breaking",
        path: `#/components/securitySchemes/${scheme}`,
        method: "SECURITY",
        description: `Security scheme removed: ${scheme}`,
        severity: "error",
      });
    }
  }

  return changes;
}

function reportResults(changes: BreakingChange[], options: ContractCheckOptions): void {
  const breaking = changes.filter(c => c.type === "breaking");
  const potentiallyBreaking = changes.filter(c => c.type === "potentially-breaking");
  const nonBreaking = changes.filter(c => c.type === "non-breaking");

  console.log("\n📊 Contract Drift Report");
  console.log("========================");
  console.log(`Breaking changes: ${breaking.length}`);
  console.log(`Potentially breaking: ${potentiallyBreaking.length}`);
  console.log(`Non-breaking changes: ${nonBreaking.length}`);

  if (breaking.length > 0) {
    console.log("\n🚨 BREAKING CHANGES:");
    for (const change of breaking) {
      console.log(`  ❌ ${change.method} ${change.path}: ${change.description}`);
    }
  }

  if (potentiallyBreaking.length > 0) {
    console.log("\n⚠️  POTENTIALLY BREAKING CHANGES:");
    for (const change of potentiallyBreaking) {
      console.log(`  ⚠️  ${change.method} ${change.path}: ${change.description}`);
    }
  }

  if (nonBreaking.length > 0) {
    console.log("\n✅ NON-BREAKING CHANGES:");
    for (const change of nonBreaking) {
      console.log(`  ✅ ${change.method} ${change.path}: ${change.description}`);
    }
  }

  // Write detailed report
  const report = {
    timestamp: new Date().toISOString(),
    summary: {
      breaking: breaking.length,
      potentiallyBreaking: potentiallyBreaking.length,
      nonBreaking: nonBreaking.length,
    },
    changes,
  };

  const outputDir = dirname(options.outputPath);
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }
  writeFileSync(options.outputPath, JSON.stringify(report, null, 2));
  console.log(`\n📄 Detailed report written to: ${options.outputPath}`);

  if (options.failOnBreaking && breaking.length > 0) {
    console.log("\n💥 Breaking changes detected! Failing build.");
    process.exit(1);
  }
}

// CLI handling
if (require.main === module) {
  const args = process.argv.slice(2);
  const baselinePath = args.find(a => a.startsWith("--baseline="))?.split("=")[1] 
    || resolve(__dirname, "../backend/openapi-baseline.json");
  const currentSpecPath = args.find(a => a.startsWith("--current="))?.split("=")[1]
    || "http://localhost:3001/docs.json";
  const failOnBreaking = args.includes("--fail-on-breaking");
  const outputPath = args.find(a => a.startsWith("--output="))?.split("=")[1]
    || resolve(__dirname, "../contract-drift-report.json");

  // If current is a URL, fetch it
  if (currentSpecPath.startsWith("http")) {
    checkContractDrift({
      baselinePath,
      currentSpecPath: resolve(__dirname, "../temp-current-spec.json"),
      failOnBreaking,
      outputPath,
    }).then(async () => {
      // Fetch current spec
      try {
        const response = await fetch(currentSpecPath);
        if (!response.ok) throw new Error(`Failed to fetch: ${response.status}`);
        const spec = await response.json();
        const tempPath = resolve(__dirname, "../temp-current-spec.json");
        writeFileSync(tempPath, JSON.stringify(spec, null, 2));
      } catch (error) {
        console.error("Failed to fetch current spec:", error);
        process.exit(1);
      }
    }).catch(console.error);
  } else {
    checkContractDrift({
      baselinePath,
      currentSpecPath,
      failOnBreaking,
      outputPath,
    }).catch(console.error);
  }
}

export { checkContractDrift };