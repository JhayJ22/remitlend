import { verifyAdminSession } from "./reviewStore";

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as Response;
}

describe("admin session verification", () => {
  it("accepts an admin session with a reviewer identity", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(
        jsonResponse(200, { data: { role: "admin", publicKey: "GADMIN123", valid: true } }),
      ) as unknown as typeof fetch;

    await expect(verifyAdminSession("token", fetchImpl)).resolves.toEqual({
      ok: true,
      role: "admin",
      publicKey: "GADMIN123",
    });
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining("/auth/verify"), {
      headers: { Authorization: "Bearer token" },
    });
  });

  it("rejects unauthorized and non-admin sessions", async () => {
    const unauthorized = jest
      .fn()
      .mockResolvedValue(jsonResponse(401, {})) as unknown as typeof fetch;
    await expect(verifyAdminSession("token", unauthorized)).resolves.toMatchObject({
      ok: false,
      status: 401,
    });

    const borrower = jest
      .fn()
      .mockResolvedValue(
        jsonResponse(200, { data: { role: "borrower" } }),
      ) as unknown as typeof fetch;
    await expect(verifyAdminSession("token", borrower)).resolves.toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it("requires an auditable reviewer identity", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(jsonResponse(200, { data: { role: "admin" } })) as unknown as typeof fetch;
    await expect(verifyAdminSession("token", fetchImpl)).resolves.toMatchObject({
      ok: false,
      status: 400,
    });
  });

  it("fails closed on session dependency errors", async () => {
    const networkFailure = jest
      .fn()
      .mockRejectedValue(new Error("offline")) as unknown as typeof fetch;
    await expect(verifyAdminSession("token", networkFailure)).resolves.toMatchObject({
      ok: false,
      status: 500,
    });

    const malformed = jest.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => {
        throw new Error("bad json");
      },
    }) as unknown as typeof fetch;
    await expect(verifyAdminSession("token", malformed)).resolves.toMatchObject({
      ok: false,
      status: 500,
    });
  });
});
