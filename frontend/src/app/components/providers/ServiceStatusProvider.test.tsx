/**
 * components/providers/ServiceStatusProvider.test.tsx
 *
 * Unit tests for the ServiceStatusProvider and useServiceStatus hook (#349).
 */

import { renderHook, waitFor, act } from "@testing-library/react";
import type { ReactNode } from "react";
import { ServiceStatusProvider, useServiceStatus } from "./ServiceStatusProvider";

function wrapper({ children }: { children: ReactNode }) {
  return <ServiceStatusProvider>{children}</ServiceStatusProvider>;
}

function mockFetch(responses: Array<{ ok: boolean; body?: unknown }>) {
  let callIndex = 0;
  return jest.fn().mockImplementation(() => {
    const res = responses[callIndex % responses.length];
    callIndex++;
    return Promise.resolve({
      ok: res.ok,
      json: () => Promise.resolve(res.body ?? {}),
    });
  });
}

describe("ServiceStatusProvider", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.useRealTimers();
  });

  it("starts with isLoading=true and health=unknown", () => {
    // Don't resolve fetch to observe the loading state
    global.fetch = jest.fn().mockReturnValue(new Promise(() => {})) as unknown as typeof fetch;
    const { result } = renderHook(() => useServiceStatus(), { wrapper });
    expect(result.current.isLoading).toBe(true);
    expect(result.current.health).toBe("unknown");
  });

  it("resolves to healthy when backend and contracts are both OK", async () => {
    global.fetch = mockFetch([
      { ok: true },
      { ok: true, body: { data: { isPaused: false } } },
    ]) as unknown as typeof fetch;

    const { result } = renderHook(() => useServiceStatus(), { wrapper });

    await waitFor(() => {
      expect(result.current.health).toBe("healthy");
    });

    expect(result.current.backendOk).toBe(true);
    expect(result.current.contractsOk).toBe(true);
    expect(result.current.isLoading).toBe(false);
  });

  it("resolves to degraded when backend is down", async () => {
    global.fetch = mockFetch([
      { ok: false },
      { ok: true, body: { data: { isPaused: false } } },
    ]) as unknown as typeof fetch;

    const { result } = renderHook(() => useServiceStatus(), { wrapper });

    await waitFor(() => {
      expect(result.current.health).toBe("degraded");
    });

    expect(result.current.backendOk).toBe(false);
  });

  it("resolves to degraded when contracts are paused", async () => {
    global.fetch = mockFetch([
      { ok: true },
      { ok: true, body: { data: { isPaused: true, reason: "Emergency maintenance" } } },
    ]) as unknown as typeof fetch;

    const { result } = renderHook(() => useServiceStatus(), { wrapper });

    await waitFor(() => {
      expect(result.current.health).toBe("degraded");
    });

    expect(result.current.backendOk).toBe(true);
    expect(result.current.contractsOk).toBe(false);
    expect(result.current.pauseReason).toBe("Emergency maintenance");
  });

  it("handles pause response JSON parse failure gracefully (fail open)", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => {
          throw new Error("bad json");
        },
      }) as unknown as typeof fetch;

    const { result } = renderHook(() => useServiceStatus(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    // Fail open: contracts are considered OK on parse error
    expect(result.current.contractsOk).toBe(true);
  });

  it("exposes a refresh function that re-runs the health check", async () => {
    let callCount = 0;
    global.fetch = jest.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve({
        ok: true,
        json: async () => ({ data: { isPaused: false } }),
      });
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useServiceStatus(), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const callsBefore = callCount;

    await act(async () => {
      result.current.refresh();
    });

    // refresh() triggers two more fetches (health + pause)
    expect(callCount).toBeGreaterThan(callsBefore);
  });

  it("throws if used outside ServiceStatusProvider", () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(() => useServiceStatus())).toThrow(
      "useServiceStatus must be used within <ServiceStatusProvider>",
    );
  });
});
