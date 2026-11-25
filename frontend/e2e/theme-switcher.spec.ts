import { test, expect } from "@playwright/test";

/**
 * Playwright spec for issue #808: ThemeSwitcher — dark/light/system modes,
 * system-preference detection, and persistence across page refresh.
 *
 * Uses Playwright's `colorScheme` context option to simulate
 * prefers-color-scheme without needing a real OS change.
 */

test.describe("ThemeSwitcher — issue #808", () => {
  test.beforeEach(async ({ page }) => {
    // Clear theme persistence so each test starts from a clean state.
    await page.addInitScript(() => {
      localStorage.removeItem("remitlend-theme");
    });
  });

  test("renders all three mode buttons", async ({ page }) => {
    await page.goto("/en/loans", { waitUntil: "domcontentloaded" });

    const switcher = page.getByRole("group", { name: /color theme/i });
    await expect(switcher).toBeVisible();

    await expect(
      switcher.getByRole("button", { name: /light mode/i }),
    ).toBeVisible();
    await expect(
      switcher.getByRole("button", { name: /dark mode/i }),
    ).toBeVisible();
    await expect(
      switcher.getByRole("button", { name: /system mode/i }),
    ).toBeVisible();
  });

  test("switching to dark mode adds 'dark' class to <html>", async ({ page }) => {
    await page.goto("/en/loans", { waitUntil: "domcontentloaded" });

    const switcher = page.getByRole("group", { name: /color theme/i });
    await switcher.getByRole("button", { name: /dark mode/i }).click();

    await expect(page.locator("html")).toHaveClass(/dark/);
  });

  test("switching to light mode removes 'dark' class from <html>", async ({ page }) => {
    await page.goto("/en/loans", { waitUntil: "domcontentloaded" });

    const switcher = page.getByRole("group", { name: /color theme/i });
    // First set dark, then light.
    await switcher.getByRole("button", { name: /dark mode/i }).click();
    await switcher.getByRole("button", { name: /light mode/i }).click();

    await expect(page.locator("html")).not.toHaveClass(/dark/);
  });

  test("selected mode persists across page refresh", async ({ page }) => {
    await page.goto("/en/loans", { waitUntil: "domcontentloaded" });

    const switcher = page.getByRole("group", { name: /color theme/i });
    await switcher.getByRole("button", { name: /dark mode/i }).click();

    // Verify the localStorage key was written.
    const stored = await page.evaluate(() =>
      localStorage.getItem("remitlend-theme"),
    );
    expect(stored).toBe("dark");

    // Reload and verify dark mode is still active.
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("html")).toHaveClass(/dark/);
  });

  test("system mode respects prefers-color-scheme: dark", async ({ browser }) => {
    const context = await browser.newContext({ colorScheme: "dark" });
    const page = await context.newPage();

    await page.addInitScript(() => {
      localStorage.removeItem("remitlend-theme");
    });

    await page.goto("/en/loans", { waitUntil: "domcontentloaded" });

    const switcher = page.getByRole("group", { name: /color theme/i });
    await switcher.getByRole("button", { name: /system mode/i }).click();

    // With system preference = dark, <html> must have class "dark".
    await expect(page.locator("html")).toHaveClass(/dark/);
    await context.close();
  });

  test("system mode respects prefers-color-scheme: light", async ({ browser }) => {
    const context = await browser.newContext({ colorScheme: "light" });
    const page = await context.newPage();

    await page.addInitScript(() => {
      localStorage.removeItem("remitlend-theme");
    });

    await page.goto("/en/loans", { waitUntil: "domcontentloaded" });

    const switcher = page.getByRole("group", { name: /color theme/i });
    await switcher.getByRole("button", { name: /system mode/i }).click();

    // With system preference = light, <html> must NOT have class "dark".
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await context.close();
  });

  test("active mode button has aria-pressed=true", async ({ page }) => {
    await page.goto("/en/loans", { waitUntil: "domcontentloaded" });

    const switcher = page.getByRole("group", { name: /color theme/i });
    const darkBtn = switcher.getByRole("button", { name: /dark mode/i });
    await darkBtn.click();

    await expect(darkBtn).toHaveAttribute("aria-pressed", "true");

    // The other buttons must not be pressed.
    await expect(
      switcher.getByRole("button", { name: /light mode/i }),
    ).toHaveAttribute("aria-pressed", "false");
    await expect(
      switcher.getByRole("button", { name: /system mode/i }),
    ).toHaveAttribute("aria-pressed", "false");
  });
});
