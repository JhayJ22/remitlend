import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  evaluateFinancialStrings,
  type FinancialStringManifest,
  type Glossary,
  type Messages,
  type ReviewState,
} from "../lib/i18n/financialTranslations";

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(resolve(process.cwd(), path), "utf8")) as T;
}

async function main() {
  const manifest = await readJson<FinancialStringManifest>("i18n/financial-strings.json");
  const glossary = await readJson<Glossary>("i18n/glossary.json");
  const reviewState = await readJson<ReviewState>("i18n/review-state.json");

  const sourceMessages = await readJson<Messages>("messages/en.json");
  const localizedEntries = await Promise.all(
    manifest.locales.map(
      async (locale) => [locale, await readJson<Messages>(`messages/${locale}.json`)] as const,
    ),
  );
  const localizedMessages = Object.fromEntries(localizedEntries);

  const result = evaluateFinancialStrings({
    manifest,
    glossary,
    reviewState,
    sourceMessages,
    localizedMessages,
  });

  if (result.blocked) {
    console.error(
      `Financial translation gate blocked release: ${result.findings.length} issue(s).`,
    );
    for (const finding of result.findings) {
      console.error(`- [${finding.code}] ${finding.locale} ${finding.key}: ${finding.message}`);
    }
    process.exit(1);
  }

  console.log(
    `Financial translation gate passed: ${result.approved}/${result.checked} reviewed strings are current.`,
  );
}

main().catch((error) => {
  console.error("Financial translation gate could not be evaluated.", error);
  process.exit(1);
});
