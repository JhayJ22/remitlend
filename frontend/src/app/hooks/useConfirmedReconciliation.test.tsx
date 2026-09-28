/**
 * hooks/useConfirmedReconciliation.test.tsx
 *
 * Unit tests for useConfirmedReconciliation (#350).
 */

import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useConfirmedReconciliation } from "./useConfirmedReconciliation";

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, wrapper };
}

describe("useConfirmedReconciliation", () => {
  it("returns a stable reconcile function", () => {
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useConfirmedReconciliation(), { wrapper });
    expect(typeof result.current.reconcile).toBe("function");
  });

  it("calls invalidateQueries for each provided key", async () => {
    const { queryClient, wrapper } = createWrapper();
    const invalidateSpy = jest.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useConfirmedReconciliation(), { wrapper });

    await result.current.reconcile({
      keys: [
        ["loans", "1"],
        ["pool", "stats"],
      ],
      txHash: "abc123",
    });

    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ["loans", "1"] }),
    );
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ["pool", "stats"] }),
    );
    expect(invalidateSpy).toHaveBeenCalledTimes(2);
  });

  it("is a no-op when keys array is empty", async () => {
    const { queryClient, wrapper } = createWrapper();
    const invalidateSpy = jest.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useConfirmedReconciliation(), { wrapper });

    await result.current.reconcile({ keys: [] });

    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("resolves without throwing when called with a txHash", async () => {
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useConfirmedReconciliation(), { wrapper });

    await expect(
      result.current.reconcile({ keys: [["loans"]], txHash: "deadbeef" }),
    ).resolves.toBeUndefined();
  });

  it("is safe to call multiple times with the same keys (idempotent)", async () => {
    const { queryClient, wrapper } = createWrapper();
    const invalidateSpy = jest.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useConfirmedReconciliation(), { wrapper });
    const keys = [["loans", "5"]];

    await result.current.reconcile({ keys });
    await result.current.reconcile({ keys });

    // Two calls → two sets of invalidations
    expect(invalidateSpy).toHaveBeenCalledTimes(2);
  });

  it("invalidates with refetchType=active so only mounted queries refetch", async () => {
    const { queryClient, wrapper } = createWrapper();
    const invalidateSpy = jest.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useConfirmedReconciliation(), { wrapper });

    await result.current.reconcile({ keys: [["pool", "stats"]] });

    expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ refetchType: "active" }));
  });
});
