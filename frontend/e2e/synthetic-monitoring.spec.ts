/**
 * synthetic-monitoring.spec.ts — Black-box synthetic monitoring (#412)
 *
 * Purpose
 * -------
 * These tests run against a live (or staging) deployment to verify that the
 * most critical user journeys are reachable and respond correctly.  They act
 * as a canary: if any check fails in production, an alert should fire.
 *
 * Scope (per issue #412)
 * ----------------------
 *   1. Backend health endpoint responds HTTP 200 with a valid JSON body.
 *   2. Frontend landing page loads and renders the expected heading.
 *   3. Backend deep-health endpoint reports all subsystems healthy.
 *   4. API error responses return structured JSON (not HTML error pages).
 *   5. Static assets (JS bundle) are served with acceptable HTTP status.
 *
 * How to run
 * ----------
 * Against staging (from repo root):
 *   SYNTHETIC_BASE_URL=https://api.staging.remitlend.com \
 *   SYNTHETIC_FRONTEND_URL=https://staging.remitlend.com \
 *   npx playwright test --config frontend/playwright.config.ts \
 *     --project=chromium e2e/synthetic-monitoring.spec.ts
 *
 * In CI (see .github/workflows/ci.yml — synthetic-monitoring job):
 *   Environment variables are injected as secrets.
 *
 * Threat model / security notes
 * ------------------------------
 * - No credentials or wallet keys are used; all checks are read-only.
 * - Responses are validated for shape only, not data values.
 * - The deep-health check intentionally hits an internal endpoint; restrict
 *   access in production to the monitoring IP range.
 */

import { test, expect, type APIResponse } from "@playwright/test";

// ── Config ────────────────────────────────────────────────────────────────────

/** Backend base URL. Falls back to localhost for local runs. */
const API_BASE =
  process.env.SYNTHETIC_BASE_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  "http://localhost:3001";

/** Frontend base URL. Falls back to localhost for local runs. */
const FRONTEND_BASE =
  process.env.SYNTHETIC_FRONTEND_URL ?? "http://localhost:3000";

/** Maximum ms to wait for any single request. */
const REQUEST_TIMEOUT_MS = 10_000;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Perform a GET request against the backend API and return the response.
 * Failures in this helper produce clear messages referencing the URL.
 */
async function apiGet(
  request: import("@playwright/test").APIRequestContext,
  path: string,
): Promise<APIResponse> {
  const url = `${API_BASE}${path}`;
  const response = await request.get(url, { timeout: REQUEST_TIMEOUT_MS });
  return response;
}

// ── Journey 1: Backend health ─────────────────────────────────────────────────

test.describe("Synthetic — Backend health", () => {
  test("GET /health returns HTTP 200", async ({ request }) => {
    const res = await apiGet(request, "/health");
    expect(
      res.status(),
      `Expected /health to return 200 but got ${res.status()} from ${API_BASE}`,
    ).toBe(200);
  });

  test("GET /health returns JSON with status field", async ({ request }) => {
    const res = await apiGet(request, "/health");
    expect(res.status()).toBe(200);

    const body = await res.json();
    // Shape check: { status: string }
    expect(typeof body).toBe("object");
    expect(body).toHaveProperty("status");
    expect(typeof body.status).toBe("string");
  });

  test("GET /health/deep returns HTTP 200 and healthy subsystems", async ({
    request,
  }) => {
    const res = await apiGet(request, "/health/deep");

    // Deep health may return 503 if a subsystem is degraded; we still parse
    // and report all subsystems to make alert debugging easier.
    const body = await res.json().catch(() => null);

    if (res.status() !== 200) {
      // Collect degraded subsystem names for the failure message
      const degraded: string[] = [];
      if (body && typeof body === "object") {
        for (const [key, val] of Object.entries(body)) {
          if (
            val !== null &&
            typeof val === "object" &&
            "status" in (val as object) &&
            (val as { status: string }).status !== "ok"
          ) {
            degraded.push(key);
          }
        }
      }
      throw new Error(
        `Deep health check failed (HTTP ${res.status()}). ` +
          `Degraded subsystems: ${degraded.join(", ") || "unknown"}. ` +
          `Full body: ${JSON.stringify(body)}`,
      );
    }

    expect(res.status()).toBe(200);
  });
});

// ── Journey 2: Frontend availability ─────────────────────────────────────────

test.describe("Synthetic — Frontend availability", () => {
  test("Landing page loads and returns HTTP 200", async ({ page }) => {
    const res = await page.goto(`${FRONTEND_BASE}/en`, {
      timeout: REQUEST_TIMEOUT_MS * 2,
      waitUntil: "domcontentloaded",
    });
    expect(
      res?.status(),
      `Landing page at ${FRONTEND_BASE}/en returned ${res?.status()}`,
    ).toBe(200);
  });

  test("Landing page contains expected heading or branding", async ({
    page,
  }) => {
    await page.goto(`${FRONTEND_BASE}/en`, {
      timeout: REQUEST_TIMEOUT_MS * 2,
      waitUntil: "domcontentloaded",
    });

    // The page must contain at least one <h1> or the brand name.
    // This is an availability signal, not a visual regression test.
    const heading = page.locator("h1").first();
    const brandText = page.locator("text=RemitLend").first();

    const [headingVisible, brandVisible] = await Promise.all([
      heading.isVisible().catch(() => false),
      brandText.isVisible().catch(() => false),
    ]);

    expect(
      headingVisible || brandVisible,
      "Expected landing page to contain a heading or 'RemitLend' branding",
    ).toBe(true);
  });

  test("Frontend serves the root path without a redirect loop", async ({
    page,
  }) => {
    // A redirect loop or broken locale middleware would cause a timeout or
    // a non-2xx final status.
    const res = await page.goto(FRONTEND_BASE, {
      timeout: REQUEST_TIMEOUT_MS * 2,
      waitUntil: "domcontentloaded",
    });

    // Allow 200 (direct) or 3xx (locale redirect to /en) resolving to 200
    const finalStatus = res?.status() ?? 0;
    expect(
      finalStatus >= 200 && finalStatus < 400,
      `Frontend root returned unexpected status: ${finalStatus}`,
    ).toBe(true);
  });
});

// ── Journey 3: API error contract ─────────────────────────────────────────────

test.describe("Synthetic — API error contract", () => {
  test("Unknown API route returns structured JSON error, not HTML", async ({
    request,
  }) => {
    // A 404 from an Express API should return JSON, not an HTML error page.
    const res = await apiGet(
      request,
      "/api/synthetic-monitoring-probe-nonexistent-route",
    );

    // Accept 404 or 400; reject HTML responses (which indicate a misconfigured
    // reverse proxy or a Next.js page swallowing API routes).
    const contentType = res.headers()["content-type"] ?? "";
    expect(
      contentType,
      "Expected API 404 to return application/json, not HTML",
    ).toContain("application/json");

    const body = await res.json().catch(() => null);
    expect(body).not.toBeNull();
  });

  test("API responds with CORS headers on cross-origin request", async ({
    request,
  }) => {
    const url = `${API_BASE}/health`;
    const res = await request.get(url, {
      timeout: REQUEST_TIMEOUT_MS,
      headers: { Origin: FRONTEND_BASE },
    });

    // Allow-Origin should be set (exact value depends on CORS config)
    const allowOrigin = res.headers()["access-control-allow-origin"];
    expect(
      allowOrigin,
      "Expected CORS header access-control-allow-origin to be present",
    ).toBeTruthy();
  });
});

// ── Journey 4: Static asset availability ─────────────────────────────────────

test.describe("Synthetic — Static assets", () => {
  test("Frontend favicon or manifest is reachable", async ({ request }) => {
    // The web manifest is a lightweight static-asset probe.
    const res = await request.get(`${FRONTEND_BASE}/manifest.webmanifest`, {
      timeout: REQUEST_TIMEOUT_MS,
    });

    // 200 OK; a 404 here means the public/ directory isn't being served.
    expect(
      [200, 304].includes(res.status()),
      `Expected manifest.webmanifest to return 200/304, got ${res.status()}`,
    ).toBe(true);
  });
});
