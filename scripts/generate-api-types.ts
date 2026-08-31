#!/usr/bin/env node

/**
 * Script to generate TypeScript types from OpenAPI spec
 * Run this when backend API changes to update frontend types
 */

import { execSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { resolve } from "path";

const BACKEND_DIR = resolve(__dirname, "../../backend");
const FRONTEND_DIR = resolve(__dirname, "../../frontend");
const OUTPUT_DIR = resolve(FRONTEND_DIR, "src/types/api");

async function generateApiTypes() {
  console.log("🔄 Generating API types from OpenAPI spec...");

  // 1. Start backend to get OpenAPI spec
  console.log("📦 Starting backend to generate OpenAPI spec...");
  
  try {
    // Try to get the OpenAPI spec from the running backend or generate it
    const openApiSpec = await fetchOpenApiSpec();
    
    // 2. Generate TypeScript types using openapi-typescript
    console.log("📝 Generating TypeScript types...");
    await generateTypesFromSpec(openApiSpec);
    
    // 3. Validate generated types
    console.log("✅ Validating generated types...");
    await validateTypes();
    
    console.log("✨ API types generated successfully!");
    console.log(`📁 Output: ${OUTPUT_DIR}`);
  } catch (error) {
    console.error("❌ Failed to generate API types:", error);
    process.exit(1);
  }
}

async function fetchOpenApiSpec(): Promise<any> {
  // Try to fetch from running backend
  try {
    const response = await fetch("http://localhost:3001/docs.json");
    if (response.ok) {
      console.log("📡 Fetched OpenAPI spec from running backend");
      return await response.json();
    }
  } catch {
    console.log("⚠️  Backend not running, trying to generate from source...");
  }

  // Fallback: Generate from backend source
  try {
    execSync("npm run build", { cwd: BACKEND_DIR, stdio: "inherit" });
    // Use swagger-jsdoc to generate from source
    const { generateOpenApiSpec } = await import(
      resolve(BACKEND_DIR, "src/config/swagger.js")
    );
    return generateOpenApiSpec();
  } catch {
    // Last resort: read existing spec file if available
    const specPath = resolve(BACKEND_DIR, "openapi.json");
    if (existsSync(specPath)) {
      console.log("📄 Reading existing OpenAPI spec file");
      return JSON.parse(readFileSync(specPath, "utf-8"));
    }
    throw new Error("Could not generate or fetch OpenAPI spec");
  }
}

async function generateTypesFromSpec(spec: any): Promise<void> {
  // Ensure output directory exists
  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // Write spec to temp file for openapi-typescript
  const tempSpecPath = resolve(OUTPUT_DIR, "temp-spec.json");
  writeFileSync(tempSpecPath, JSON.stringify(spec, null, 2));

  // Generate types using openapi-typescript
  try {
    execSync(
      `npx openapi-typescript ${tempSpecPath} -o ${OUTPUT_DIR}/api.ts`,
      { stdio: "inherit" }
    );
  } finally {
    // Clean up temp file
    if (existsSync(tempSpecPath)) {
      require("fs").unlinkSync(tempSpecPath);
    }
  }

  // Also generate Zod schemas for runtime validation
  await generateZodSchemas(spec);
}

async function generateZodSchemas(spec: any): Promise<void> {
  try {
    const { generateZodSchemas: generate } = await import("openapi-zod-generator");

    const zodOutput = await generate(spec, {
      outputDir: OUTPUT_DIR,
      fileName: "api-schemas.ts",
      includePaths: true,
      includeComponents: true,
    });

    writeFileSync(resolve(OUTPUT_DIR, "api-schemas.ts"), zodOutput);
    return;
  } catch {
    console.log("⚠️ openapi-zod-generator is not installed; skipping Zod schema generation.");
  }

  const outputPath = resolve(OUTPUT_DIR, "api-schemas.ts");
  writeFileSync(
    outputPath,
    `export const apiSchemas = {} as const;\nexport default apiSchemas;\n`,
  );
}

async function validateTypes(): Promise<void> {
  // Run TypeScript compiler to validate
  try {
    execSync("npx tsc --noEmit", { 
      cwd: FRONTEND_DIR, 
      stdio: "inherit" 
    });
  } catch {
    throw new Error("TypeScript validation failed");
  }
}

// Run if called directly
if (require.main === module) {
  generateApiTypes().catch(console.error);
}

export { generateApiTypes };