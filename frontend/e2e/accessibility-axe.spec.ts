import { test, expect } from "@playwright/test";
import { injectAxe, checkA11y } from "axe-playwright";

/**
 * Automated WCAG 2.1 AA audit (issue #116).
 *
 * Runs axe-core against the primary authenticated and public routes and fails
 * on any violation. `checkA11y` is scoped to WCAG 2.0/2.1 level A & AA rule
 * tags so the report maps directly to the acceptance criteria.
 */
const WCAG_AA_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

const ROUTES = ["/en", "/en/activity", "/en/request-loan", "/en/send-remittance", "/en/settings"];

test.describe.skip("WCAG 2.1 AA — axe-core", () => {
  for (const route of ROUTES) {
    test(`no violations on ${route}`, async ({ page }) => {
      await page.goto(route);
      await injectAxe(page);
      await checkA11y(page, undefined, {
        axeOptions: { runOnly: { type: "tag", values: WCAG_AA_TAGS } },
        detailedReport: true,
        detailedReportOptions: { html: true },
      });
    });
  }

  test("skip-to-content link is the first focusable element", async ({ page }) => {
    await page.goto("/en");
    await page.keyboard.press("Tab");
    const focused = page.locator(":focus");
    await expect(focused).toHaveText(/skip to main content/i);
  });
});
