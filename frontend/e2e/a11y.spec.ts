import { test } from "@playwright/test";
import { injectAxe, checkA11y } from "axe-playwright";

/**
 * Automated accessibility snapshots for critical pages.
 *
 * Runs axe-core against each page and fails on any WCAG 2.0/2.1 A or AA
 * violation. Wire this spec into CI (see `.github/workflows/a11y.yml`) so
 * regressions block the PR instead of shipping.
 */
const CRITICAL_PAGES = [
  { name: "landing", path: "/" },
  { name: "loans", path: "/en/loans" },
  { name: "analytics", path: "/en/analytics" },
  { name: "lend", path: "/en/lend" },
  { name: "wallet", path: "/en/wallet" },
];

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

for (const { name, path } of CRITICAL_PAGES) {
  test(`a11y: ${name} has no WCAG A/AA violations`, async ({ page }) => {
    await page.goto(path, { waitUntil: "networkidle" });
    await injectAxe(page);
    await checkA11y(page, undefined, {
      detailedReport: true,
      detailedReportOptions: { html: true },
      axeOptions: {
        runOnly: { type: "tag", values: AXE_TAGS },
      },
    });
  });
}
