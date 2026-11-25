import { test, expect, type Page, type Route } from "@playwright/test";

/**
 * Wallet disconnect cleanup (#795).
 *
 * Covers useDisconnectWallet + DisconnectWalletDialog end-to-end:
 *   - normal disconnect: JWT revoked server-side, stores cleared, redirect home
 *   - disconnect with pending offline-queue items: warning shown, queue
 *     discarded (never replayed), then the same cleanup
 */

const MOCK_ADDRESS = "GCJPBXSE6WCQDCEYZW6C3YVZCSSCHC4AE72L5KWKCYL2CLLL7NH5VSCI";
const AUTH_TOKEN = "test-jwt-token";
const OFFLINE_QUEUE_KEY = "remitlend:offline-queue";

interface SeedOptions {
  queuedActions?: number;
}

async function seedSession(page: Page, { queuedActions = 0 }: SeedOptions = {}) {
  await page.addInitScript(
    ({ address, token, queueKey, queued }) => {
      // Seed only on the first load so the post-disconnect navigation sees
      // the real cleared state rather than a re-seeded session.
      if (window.sessionStorage.getItem("e2e-seeded")) return;
      window.sessionStorage.setItem("e2e-seeded", "1");

      window.localStorage.setItem(
        "remitlend-wallet",
        JSON.stringify({
          state: {
            status: "connected",
            address,
            network: { chainId: 2, name: "TESTNET", isSupported: true },
            balances: [{ symbol: "USDC", amount: "5000.00", usdValue: 5000 }],
            shouldAutoReconnect: false,
          },
          version: 0,
        }),
      );
      window.localStorage.setItem(
        "remitlend-user",
        JSON.stringify({
          state: {
            user: {
              id: "user-1",
              email: "e2e@example.com",
              walletAddress: address,
              kycVerified: true,
            },
            authToken: token,
            isAuthenticated: true,
          },
          version: 0,
        }),
      );
      const queue = Array.from({ length: queued }, (_, i) => ({
        id: `queued-${i}`,
        url: "http://localhost:3001/api/loans/request",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: 100 + i }),
        label: `Loan request ${i + 1}`,
        queuedAt: Date.now(),
        attempts: 0,
      }));
      window.localStorage.setItem(queueKey, JSON.stringify(queue));
    },
    {
      address: MOCK_ADDRESS,
      token: AUTH_TOKEN,
      queueKey: OFFLINE_QUEUE_KEY,
      queued: queuedActions,
    },
  );
}

/** Captures POST /auth/logout and stubs the endpoints the dashboard touches. */
async function mockApi(page: Page) {
  const logoutCalls: Array<{ authorization: string | undefined }> = [];

  await page.route("**/api/auth/logout", async (route: Route) => {
    logoutCalls.push({ authorization: route.request().headers()["authorization"] });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true }),
    });
  });
  await page.route("**/api/loans/request", async (route: Route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  await page.route("**/api/user/profile", async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: "user-1", walletAddress: MOCK_ADDRESS, kycVerified: true }),
    });
  });

  return { logoutCalls };
}

async function openDisconnectDialog(page: Page) {
  await page.goto("/en/dashboard");
  await page.locator('button[aria-label="Disconnect wallet"]:visible').first().click();
  const dialog = page.getByTestId("disconnect-wallet-dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

async function expectCleanedUp(page: Page) {
  await expect(page).toHaveURL(/\/en\/?$/);
  const state = await page.evaluate((queueKey) => {
    const parse = (k: string) => {
      const raw = window.localStorage.getItem(k);
      return raw ? JSON.parse(raw) : null;
    };
    return {
      wallet: parse("remitlend-wallet")?.state,
      user: parse("remitlend-user")?.state,
      queue: parse(queueKey) ?? [],
    };
  }, OFFLINE_QUEUE_KEY);

  expect(state.wallet?.status).not.toBe("connected");
  expect(state.wallet?.address ?? null).toBeNull();
  expect(state.user?.authToken ?? null).toBeNull();
  expect(state.user?.isAuthenticated ?? false).toBe(false);
  expect(state.queue).toHaveLength(0);
}

test.describe("Wallet disconnect cleanup", () => {
  test("normal disconnect revokes the JWT, clears state and redirects home", async ({ page }) => {
    await seedSession(page);
    const api = await mockApi(page);

    const dialog = await openDisconnectDialog(page);
    await expect(dialog.getByTestId("disconnect-pending-warning")).toHaveCount(0);

    await dialog.getByTestId("confirm-disconnect").click();

    await expect.poll(() => api.logoutCalls.length).toBe(1);
    expect(api.logoutCalls[0]!.authorization).toBe(`Bearer ${AUTH_TOKEN}`);
    await expectCleanedUp(page);
  });

  test("cancel keeps the session intact", async ({ page }) => {
    await seedSession(page);
    const api = await mockApi(page);

    const dialog = await openDisconnectDialog(page);
    await dialog.getByRole("button", { name: "Cancel" }).click();

    await expect(dialog).toBeHidden();
    expect(api.logoutCalls).toHaveLength(0);
    const token = await page.evaluate(
      () => JSON.parse(window.localStorage.getItem("remitlend-user") ?? "{}")?.state?.authToken,
    );
    expect(token).toBe(AUTH_TOKEN);
  });

  test("warns about pending offline actions and discards them on confirm", async ({ page }) => {
    await seedSession(page, { queuedActions: 2 });
    const api = await mockApi(page);

    // The app replays the queue on mount. Hold the first replay open so both
    // items are still pending when the user opens the dialog.
    const held: Route[] = [];
    let replayAttempts = 0;
    await page.unroute("**/api/loans/request");
    await page.route("**/api/loans/request", async (route: Route) => {
      replayAttempts += 1;
      held.push(route);
    });

    const dialog = await openDisconnectDialog(page);
    const warning = dialog.getByTestId("disconnect-pending-warning");
    await expect(warning).toBeVisible();
    await expect(warning).toContainText("2 offline actions");
    await expect(dialog.getByTestId("confirm-disconnect")).toHaveText("Discard and disconnect");

    await dialog.getByTestId("confirm-disconnect").click();

    await expect.poll(() => api.logoutCalls.length).toBe(1);
    await expectCleanedUp(page);

    // Release the in-flight replay: the discarded second item must never be sent.
    const attemptsBeforeRelease = replayAttempts;
    await Promise.all(
      held.map((r) => r.fulfill({ status: 200, contentType: "application/json", body: "{}" })),
    );
    await page.waitForTimeout(500);
    expect(replayAttempts).toBe(attemptsBeforeRelease);
    expect(attemptsBeforeRelease).toBeLessThanOrEqual(1);
    const queue = await page.evaluate(
      (k) => JSON.parse(window.localStorage.getItem(k) ?? "[]"),
      OFFLINE_QUEUE_KEY,
    );
    expect(queue).toHaveLength(0);
  });
});
