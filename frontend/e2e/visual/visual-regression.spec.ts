import { test, expect } from "@playwright/test";

/**
 * Issue #111 — Visual regression testing.
 *
 * `toHaveScreenshot` writes a baseline PNG on first run (commit these under
 * `e2e/visual/visual-regression.spec.ts-snapshots/`) and fails the run on any
 * pixel diff above `maxDiffPixelRatio`. Wired into CI via
 * `.github/workflows/visual-regression.yml`, so a PR that changes the rendered
 * UI without an intentional baseline update (`npm run test:visual:update`) is
 * blocked on the required check.
 *
 * Add a page here when a new top-level screen ships.
 */
const PAGES = [
  { name: "landing", path: "/" },
  { name: "lend", path: "/en/lend" },
  { name: "activity", path: "/en/activity" },
  { name: "send-remittance", path: "/en/send" },
  { name: "settings", path: "/en/settings" },
  { name: "admin-disputes", path: "/en/admin/disputes" },
  { name: "admin-governance", path: "/en/admin/governance" },
];

test.describe("visual regression", () => {
  for (const { name, path } of PAGES) {
    test(name, async ({ page }) => {
      await page.goto(path, { waitUntil: "networkidle" });

      // Freeze anything time- or motion-dependent so baselines are stable.
      await page.addStyleTag({
        content: `*,*::before,*::after{
          transition:none!important;
          animation:none!important;
          caret-color:transparent!important;
        }`,
      });
      await page.evaluate(() => document.fonts.ready);

      await expect(page).toHaveScreenshot(`${name}.png`, {
        fullPage: true,
        animations: "disabled",
        maxDiffPixelRatio: 0.01,
      });
    });
  }
});
