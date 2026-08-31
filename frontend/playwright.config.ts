import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  // 🔑 Relative to the folder you run Playwright from (frontend/)
  testDir: "./e2e",

  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "html",

  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
    headless: true, // good for CI
  },

  projects: [
    {
      name: "chromium",
      testIgnore: "visual/**",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "firefox",
      testIgnore: "visual/**",
      use: { ...devices["Desktop Firefox"] },
    },
    {
      name: "webkit",
      testIgnore: "visual/**",
      use: { ...devices["Desktop Safari"] },
    },
    {
      // Issue #111: visual regression baselines. Chromium-only so the
      // committed snapshots are deterministic across machines and CI.
      name: "visual",
      testDir: "./e2e/visual",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    // timeout: 120000, // optional if dev server is slow
  },
});
