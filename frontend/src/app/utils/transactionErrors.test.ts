import { mapTransactionError, pollTransactionStatus } from "./transactionErrors";

type FetchArgs = [input: RequestInfo | URL, init?: RequestInit];
type MockResponse = { status: number; successful?: boolean } | Error;

/** Unused queue entries mean "keep returning 404 / still pending". */
function mockFetchSequence(responses: MockResponse[]) {
  const calls: FetchArgs[] = [];
  const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push([input, init]);
    const next = responses.shift() ?? { status: 404 };
    if (next instanceof Error) throw next;
    if (next.status === 404) {
      return { status: 404, ok: false, json: async () => ({}) } as unknown as Response;
    }
    return {
      status: next.status,
      ok: next.status >= 200 && next.status < 300,
      json: async () => ({ successful: next.successful ?? next.status === 200 }),
    } as unknown as Response;
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return { fetchMock, calls };
}

const noSleep = async () => {};

describe("mapTransactionError", () => {
  it("maps a wallet rejection to a non-charged, user-initiated outcome", () => {
    const details = mapTransactionError(new Error("User rejected the request"));
    expect(details.category).toBe("wallet_rejected");
    expect(details.cancelledByUser).toBe(true);
    expect(details.retryable).toBe(true);
  });

  it("maps an expired request to its own category", () => {
    expect(mapTransactionError(new Error("Transaction has expired")).category).toBe("expired");
    expect(mapTransactionError({ code: "CHALLENGE_EXPIRED" }).category).toBe("expired");
  });

  it("prefers expiry over a generic network classification", () => {
    const details = mapTransactionError(new Error("network session expired"));
    expect(details.category).toBe("expired");
  });

  it("maps insufficient balance as non-retryable", () => {
    const details = mapTransactionError(new Error("Insufficient balance"));
    expect(details.category).toBe("insufficient_balance");
    expect(details.retryable).toBe(false);
  });

  it("falls back to unknown without throwing on odd values", () => {
    expect(mapTransactionError(undefined).category).toBe("unknown");
    expect(mapTransactionError({ code: 7 }).category).toBe("unknown");
  });
});

describe("pollTransactionStatus", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("returns success as soon as Horizon confirms the transaction", async () => {
    mockFetchSequence([{ status: 200, successful: true }]);
    const result = await pollTransactionStatus("hash", {
      sleep: noSleep,
      requestTimeoutMs: 0,
    });
    expect(result.status).toBe("success");
    expect(result.attempts).toBe(1);
    expect(result.dependencyFailure).toBe(false);
  });

  it("returns failed for a confirmed on-chain failure", async () => {
    mockFetchSequence([{ status: 200, successful: false }]);
    const result = await pollTransactionStatus("hash", {
      sleep: noSleep,
      requestTimeoutMs: 0,
    });
    expect(result.status).toBe("failed");
    expect(result.dependencyFailure).toBe(false);
  });

  it("treats a 5xx as a dependency failure, not a settled failure", async () => {
    mockFetchSequence([{ status: 503 }]);
    const result = await pollTransactionStatus("hash", {
      sleep: noSleep,
      requestTimeoutMs: 0,
      maxAttempts: 1,
    });
    expect(result.status).toBe("timeout");
    expect(result.dependencyFailure).toBe(true);
  });

  it("treats 404 as still pending and keeps polling", async () => {
    mockFetchSequence([{ status: 404 }, { status: 200, successful: true }]);
    const result = await pollTransactionStatus("hash", {
      sleep: noSleep,
      requestTimeoutMs: 0,
    });
    expect(result.status).toBe("success");
    expect(result.attempts).toBe(2);
  });

  it("bounds the number of horizon lookups", async () => {
    const { fetchMock } = mockFetchSequence([]);
    const result = await pollTransactionStatus("hash", {
      sleep: noSleep,
      requestTimeoutMs: 0,
      maxAttempts: 3,
      timeoutMs: 60_000,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.status).toBe("timeout");
    expect(result.attempts).toBe(3);
  });

  it("respects the wall-clock timeout", async () => {
    mockFetchSequence([]);
    let now = 0;
    const sleep = async () => {
      now += 1_000;
    };
    jest.spyOn(Date, "now").mockImplementation(() => now);
    const result = await pollTransactionStatus("hash", {
      sleep,
      requestTimeoutMs: 0,
      timeoutMs: 2_500,
    });
    expect(result.status).toBe("timeout");
    expect(now).toBeGreaterThanOrEqual(2_500);
  });

  it("reports a dependency failure without claiming the transaction failed", async () => {
    mockFetchSequence([new Error("offline"), new Error("offline")]);
    const result = await pollTransactionStatus("hash", {
      sleep: noSleep,
      requestTimeoutMs: 0,
      maxAttempts: 2,
    });
    expect(result.status).toBe("timeout");
    expect(result.dependencyFailure).toBe(true);
    expect(result.message).toMatch(/Could not reach the network/);
  });

  it("returns cancelled immediately when the signal is already aborted", async () => {
    const { fetchMock } = mockFetchSequence([{ status: 200, successful: true }]);
    const controller = new AbortController();
    controller.abort();
    const result = await pollTransactionStatus("hash", {
      signal: controller.signal,
      sleep: noSleep,
    });
    expect(result.status).toBe("cancelled");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("propagates an abort that happens mid-poll", async () => {
    const controller = new AbortController();
    mockFetchSequence([{ status: 200, successful: true }]);
    global.fetch = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      controller.abort();
      const error = new Error("aborted");
      (error as Error & { name: string }).name = "AbortError";
      if (init?.signal?.aborted) throw error;
      throw error;
    }) as unknown as typeof fetch;

    const result = await pollTransactionStatus("hash", {
      signal: controller.signal,
      sleep: noSleep,
      requestTimeoutMs: 0,
    });
    expect(result.status).toBe("cancelled");
  });

  it("passes an abort signal and a bounded request timeout to fetch", async () => {
    const { calls } = mockFetchSequence([{ status: 200, successful: true }]);
    await pollTransactionStatus("hash", {
      sleep: noSleep,
      requestTimeoutMs: 1_234,
    });
    expect(calls[0][0]).toBe("https://horizon-testnet.stellar.org/transactions/hash");
    expect(calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });
});
