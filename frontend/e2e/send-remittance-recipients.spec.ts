import { test, expect, type Page, type Route } from "@playwright/test";

const SENDER = "GCJPBXSE6WCQDCEYZW6C3YVZCSSCHC4AE72L5KWKCYL2CLLL7NH5VSCI";
const RECIPIENT = "GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIBTLFL2F7HVRQG5LDHNWY2QTWA";

async function setup(page: Page, saved: Array<{ id: string; name: string; address: string }>) {
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
  await page.route("**/user/recipients", async (route: Route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON() as { name: string; address: string };
      saved.push({ id: "r-new", ...body });
      return route.fulfill({ status: 201, json: { success: true, data: saved[saved.length - 1] } });
    }
    return route.fulfill({ json: { success: true, data: saved } });
  });
  await page.route("**/api/recipients/*/reveal", (route) =>
    route.fulfill({ json: { value: "revealed" } }),
  );
}

test.describe("send remittance recipients", () => {
  test("saves and selects a recipient; PII masked until reveal", async ({ page }) => {
    const saved: Array<{ id: string; name: string; address: string }> = [];
    await setup(page, saved);
    await page.goto("/en/send-remittance");

    await page.getByPlaceholder("G... (Stellar public key)").fill(RECIPIENT);
    await page.getByLabel("Recipient name").fill("Mama");
    await page.getByRole("button", { name: "Save recipient" }).click();

    const address = page.getByTestId("recipient-address-r-new");
    await expect(address).toContainText("••••");
    await expect(address).not.toHaveText(RECIPIENT);

    await page.getByPlaceholder("G... (Stellar public key)").fill("");
    await page.getByRole("button", { name: "Use" }).click();
    await expect(page.getByPlaceholder("G... (Stellar public key)")).toHaveValue(RECIPIENT);

    await page.getByRole("button", { name: "Reveal" }).click();
    await expect(address).toHaveText(RECIPIENT);
  });

  test("QR scanner decodes a Stellar G-address (mocked camera)", async ({ page }) => {
    await setup(page, []);
    await page.addInitScript(
      ({ payload }) => {
        const track = { stop() {} };
        const fakeStream = { getTracks: () => [track] } as unknown as MediaStream;
        Object.defineProperty(navigator, "mediaDevices", {
          value: { getUserMedia: async () => fakeStream },
          configurable: true,
        });
        HTMLMediaElement.prototype.play = async () => undefined;
        (window as unknown as { BarcodeDetector: unknown }).BarcodeDetector = class {
          async detect() {
            return [{ rawValue: payload }];
          }
        };
      },
      { payload: `web+stellar:pay?destination=${RECIPIENT}` },
    );
    await page.goto("/en/send-remittance");
    await page.getByRole("button", { name: "Scan QR" }).click();
    await expect(page.getByPlaceholder("G... (Stellar public key)")).toHaveValue(RECIPIENT);
  });

  test("invalid address shows an error before submission", async ({ page }) => {
    await setup(page, []);
    await page.goto("/en/send-remittance");
    await page.getByPlaceholder("G... (Stellar public key)").fill("NOT-AN-ADDRESS");
    await expect(page.getByText(/Invalid Stellar address/).first()).toBeVisible();
  });
});
