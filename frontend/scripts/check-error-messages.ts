import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ERROR_GUIDANCE_KEYS,
  SUPPORTED_ERROR_CODES,
  guidanceKeyForCode,
  type ErrorAction,
} from "../src/lib/errors";

const LOCALES = ["en", "es", "tl"];
const ACTIONS: ErrorAction[] = ["retry", "reauthenticate", "contact_support", "refresh", "none"];

async function readText(path: string): Promise<string> {
  return readFile(resolve(process.cwd(), path), "utf8");
}

async function main() {
  const enumSource = await readText("../backend/src/errors/errorCodes.ts");
  const enumBody = enumSource.match(/export enum ErrorCode \{([\s\S]*?)\n\}/)?.[1] ?? "";
  const backendCodes = [...enumBody.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*=/gm)].map(
    (match) => match[1],
  );
  const problems: string[] = [];

  if (backendCodes.length === 0) problems.push("Could not read backend ErrorCode enum.");

  for (const code of backendCodes) {
    if (!guidanceKeyForCode(code))
      problems.push(`No presentation mapping for backend code ${code}.`);
  }

  const messages = Object.fromEntries(
    await Promise.all(
      LOCALES.map(async (locale) => [
        locale,
        JSON.parse(await readText(`messages/${locale}.json`)) as {
          Errors?: {
            referenceLabel?: string;
            actions?: Record<string, string>;
            guidance?: Record<string, { title?: string; message?: string; guidance?: string }>;
          };
        },
      ]),
    ),
  );

  for (const locale of LOCALES) {
    const errors = messages[locale].Errors;
    if (!errors) {
      problems.push(`${locale}.json is missing the Errors namespace.`);
      continue;
    }
    if (!errors.referenceLabel?.trim())
      problems.push(`${locale}.json has no Errors.referenceLabel.`);
    for (const action of ACTIONS) {
      if (!errors.actions?.[action]?.trim())
        problems.push(`${locale}.json has no Errors.actions.${action}.`);
    }
    for (const key of ERROR_GUIDANCE_KEYS) {
      const entry = errors.guidance?.[key];
      if (!entry?.title?.trim()) problems.push(`${locale}.json has no guidance title for ${key}.`);
      if (!entry?.message?.trim())
        problems.push(`${locale}.json has no guidance message for ${key}.`);
      if (!entry?.guidance?.trim())
        problems.push(`${locale}.json has no guidance text for ${key}.`);
    }
    for (const key of Object.keys(errors.guidance ?? {})) {
      if (!ERROR_GUIDANCE_KEYS.includes(key as (typeof ERROR_GUIDANCE_KEYS)[number])) {
        problems.push(`${locale}.json has an unrecognized guidance key ${key}.`);
      }
    }
  }

  const unmapped = SUPPORTED_ERROR_CODES.filter((code) => !backendCodes.includes(code));
  const legacyCodes = unmapped.filter((code) => !["SERVICE_OVERLOADED"].includes(code));
  if (legacyCodes.length > 0)
    problems.push(
      `Presentation mapping has codes outside the backend contract: ${legacyCodes.join(", ")}.`,
    );

  if (problems.length > 0) {
    console.error(`Actionable error message gate blocked release: ${problems.length} issue(s).`);
    for (const problem of problems) console.error(`- ${problem}`);
    process.exit(1);
  }

  console.log(
    `Actionable error message gate passed: ${backendCodes.length} backend codes, ${ERROR_GUIDANCE_KEYS.length} guidance categories, ${LOCALES.length} locales.`,
  );
}

main().catch((error) => {
  console.error("Actionable error message gate could not be evaluated.", error);
  process.exit(1);
});
