import { readFile } from "node:fs/promises";

const locales = ["en", "es", "tl"];

function flatten(value, prefix = "") {
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return child && typeof child === "object" ? flatten(child, path) : [path];
  });
}

const messages = Object.fromEntries(
  await Promise.all(
    locales.map(async (locale) => [locale, JSON.parse(await readFile(`messages/${locale}.json`, "utf8"))]),
  ),
);
const referenceKeys = new Set(flatten(messages.en));
let failed = false;

for (const locale of locales.slice(1)) {
  const keys = new Set(flatten(messages[locale]));
  for (const key of referenceKeys) {
    if (!keys.has(key)) {
      console.error(`${locale}.json is missing ${key}`);
      failed = true;
    }
  }
}

if (failed) process.exit(1);
console.log(`Translation key parity passed for ${locales.join(", ")}`);
