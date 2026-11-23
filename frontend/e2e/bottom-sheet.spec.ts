import { test, expect, type Page, type Locator } from "@playwright/test";

/**
 * Issue #783: action dialogs render as a BottomSheet below 768px and as the
 * centered Modal on desktop. Every action modal (repay preview, collateral
 * deposit/withdraw, extension, refinance, confirm) goes through the shared
 * `Modal`, so the dev-only /en/ui-demo gallery exercises the same code path
 * without wallet/API mocks.
 */

const DEMO_URL = "/en/ui-demo";

async function openDemoModal(page: Page): Promise<void> {
  await page.goto(DEMO_URL);
  await page.getByRole("button", { name: "Open Demo Modal" }).click();
}

async function swipe(handle: Locator, deltaY: number): Promise<void> {
  const box = await handle.boundingBox();
  if (!box) throw new Error("handle not visible");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await handle.evaluate(
    (el, { x, y, deltaY }) => {
      const touch = (clientY: number) =>
        new Touch({ identifier: 1, target: el, clientX: x, clientY });
      el.dispatchEvent(
        new TouchEvent("touchstart", { bubbles: true, touches: [touch(y)], changedTouches: [touch(y)] }),
      );
      el.dispatchEvent(
        new TouchEvent("touchend", {
          bubbles: true,
          touches: [],
          changedTouches: [touch(y + deltaY)],
        }),
      );
    },
    { x, y, deltaY },
  );
}

test.describe("Mobile bottom sheet (375px)", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

  test.beforeEach(({ browserName }) => {
    test.skip(browserName !== "chromium", "Touch constructor is Chromium-only");
  });

  test("action modal renders as an accessible bottom sheet", async ({ page }) => {
    await openDemoModal(page);

    const sheet = page.getByTestId("bottom-sheet");
    await expect(sheet).toBeVisible();
    await expect(page.getByTestId("modal-dialog")).toHaveCount(0);
    await expect(sheet).toHaveAttribute("role", "dialog");
    await expect(sheet).toHaveAttribute("aria-modal", "true");
    await expect(page.getByRole("dialog", { name: "Privacy Settings" })).toBeVisible();

    // Anchored to the bottom edge and full width.
    const box = await sheet.boundingBox();
    expect(box).not.toBeNull();
    expect(Math.round(box!.y + box!.height)).toBeGreaterThanOrEqual(810);
    expect(Math.round(box!.width)).toBe(375);
  });

  test("focus is trapped inside the sheet", async ({ page }) => {
    await openDemoModal(page);
    const sheet = page.getByTestId("bottom-sheet");
    await expect(page.getByRole("button", { name: "Close" })).toBeFocused();

    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Tab");
      const inside = await sheet.evaluate((el) => el.contains(document.activeElement));
      expect(inside).toBe(true);
    }
  });

  test("Escape dismisses the sheet and restores focus", async ({ page }) => {
    await openDemoModal(page);
    await expect(page.getByTestId("bottom-sheet")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("bottom-sheet")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Open Demo Modal" })).toBeFocused();
  });

  test("swipe down on the handle dismisses the sheet", async ({ page }) => {
    await openDemoModal(page);
    const handle = page.getByTestId("bottom-sheet-handle");

    // A short drag below the threshold keeps it open.
    await swipe(handle, 20);
    await expect(page.getByTestId("bottom-sheet")).toBeVisible();

    await swipe(handle, 200);
    await expect(page.getByTestId("bottom-sheet")).toHaveCount(0);
  });
});

test.describe("Desktop modal (no regression)", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("renders the centered modal, not a bottom sheet", async ({ page }) => {
    await openDemoModal(page);
    await expect(page.getByTestId("modal-dialog")).toBeVisible();
    await expect(page.getByTestId("bottom-sheet")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("modal-dialog")).toHaveCount(0);
  });
});
