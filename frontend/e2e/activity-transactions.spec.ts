import { test, expect, type Page } from "@playwright/test";

const SENDER = "GCJPBXSE6WCQDCEYZW6C3YVZCSSCHC4AE72L5KWKCYL2CLLL7NH5VSCI";

async function setup(page: Page, items: unknown[]) {
  await page.addInitScript(
    ({ sender }) => {
      localStorage.setItem(
        "wallet-storage",
        JSON.stringify({
          state: { status: "connected", address: sender, shouldAutoReconnect: true },
          version: 0,
        }),
      );
    },
    { sender: SENDER },
  );
  await page.route("**/transactions?*", (route) =>
    route.fulfill({
      json: {
        success: true,
        data: items,
        page_info: { limit: 100, count: items.length, next_cursor: null, has_next: false },
      },
    }),
  );
}

const tx = (id: number, status: string, type = "remittance") => ({
  id,
  txHash: `hash${id}`.padEnd(64, "a"),
  status,
  submittedAt: "2026-01-01T00:00:00Z",
  submittedBy: SENDER,
  transactionType: type,
});

test.describe("activity on-chain transactions", () => {
  test("renders statuses and the failed-tx retry flow", async ({ page }) => {
    await setup(page, [tx(1, "confirmed"), tx(2, "pending"), tx(3, "failed")]);
    await page.goto("/en/activity");

    const rows = page.getByTestId("tx-row");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(2)).toContainText("failed");

    await rows.nth(2).getByRole("button", { name: "Retry" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
  });

  test("shows the empty state", async ({ page }) => {
    await setup(page, []);
    await page.goto("/en/activity");
    await expect(page.getByText("No transactions yet")).toBeVisible();
  });
});
