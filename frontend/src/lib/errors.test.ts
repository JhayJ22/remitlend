import {
  ERROR_GUIDANCE_KEYS,
  extractErrorCode,
  extractReferenceId,
  guidanceKeyForCode,
  localizeError,
  nextRetryDelayMs,
  presentError,
  requiresReauthentication,
  SUPPORTED_ERROR_CODES,
} from "./errors";

describe("actionable error presentation", () => {
  it("maps stable backend codes to guidance without using server text", () => {
    const payload = {
      success: false,
      message: "Postgres connection string postgres://internal:secret@db",
      error: { code: "INSUFFICIENT_BALANCE", message: "raw stack trace at /srv/app" },
    };
    const presentation = presentError(payload);

    expect(presentation.code).toBe("INSUFFICIENT_BALANCE");
    expect(presentation.guidanceKey).toBe("insufficientFunds");
    expect(presentation.retryable).toBe(true);
    expect(presentation.action).toBe("refresh");
    expect(JSON.stringify(presentation)).not.toContain("postgres://internal");
    expect(JSON.stringify(presentation)).not.toContain("stack trace");
  });

  it("supports legacy, structured, and axios-shaped payloads", () => {
    expect(extractErrorCode("RATE_LIMIT_EXCEEDED")).toBe("RATE_LIMIT_EXCEEDED");
    expect(extractErrorCode({ error: { code: "TOKEN_EXPIRED" } })).toBe("TOKEN_EXPIRED");
    expect(extractErrorCode({ response: { data: { error: { code: "FORBIDDEN" } } } })).toBe(
      "FORBIDDEN",
    );
    expect(extractErrorCode({ code: "not-a-code" })).toBeNull();
    expect(extractErrorCode({ code: "../../etc/passwd" })).toBeNull();
  });

  it("preserves safe technical reference IDs verbatim", () => {
    const payload = {
      error: {
        code: "BLOCKCHAIN_ERROR",
        requestId: "req_01J9Z8P2Q7-abc.def",
        message: "internal host db-17",
      },
      response: { headers: { "x-request-id": "ignored-secondary" } },
    };

    expect(extractReferenceId(payload)).toBe("req_01J9Z8P2Q7-abc.def");
    expect(presentError(payload).referenceId).toBe("req_01J9Z8P2Q7-abc.def");
    expect(extractReferenceId({ referenceId: "bad id with spaces" })).toBeNull();
    expect(extractReferenceId({ referenceId: "<script>alert(1)</script>" })).toBeNull();
  });

  it("uses fallback copy for unknown codes while keeping the identifier", () => {
    const presentation = presentError({
      error: { code: "NEW_BACKEND_CODE", message: "internal detail" },
    });
    expect(presentation).toMatchObject({
      code: "NEW_BACKEND_CODE",
      guidanceKey: "fallback",
      retryable: false,
    });
    expect(JSON.stringify(presentation)).not.toContain("internal detail");
  });

  it("localizes guidance but never the code or reference ID", () => {
    const presentation = presentError({
      error: { code: "CHALLENGE_EXPIRED", referenceId: "REF-123" },
    });
    const translations: Record<string, string> = {};
    const localized = localizeError(presentation, (key) => {
      translations[key] = `localized:${key}`;
      return translations[key];
    });

    expect(localized.code).toBe("CHALLENGE_EXPIRED");
    expect(localized.referenceId).toBe("REF-123");
    expect(localized.title).toBe("localized:Errors.guidance.sessionExpired.title");
    expect(localized.guidance).toBe("localized:Errors.guidance.sessionExpired.guidance");
    expect(localized.actionLabel).toBe("localized:Errors.actions.refresh");
    expect(requiresReauthentication(presentError({ code: "TOKEN_EXPIRED" }))).toBe(true);
  });

  it("keeps retry behavior bounded and explicitly disabled for unsafe actions", () => {
    const retryable = presentError({ code: "RATE_LIMIT_EXCEEDED" });
    expect(nextRetryDelayMs(retryable, 1)).toBe(5000);
    expect(nextRetryDelayMs(retryable, 99)).toBe(30000);
    expect(nextRetryDelayMs(presentError({ code: "FORBIDDEN" }), 1)).toBeNull();
  });

  it("maps every declared backend code to a localized guidance category", () => {
    expect(SUPPORTED_ERROR_CODES).toContain("SERVICE_OVERLOADED");
    for (const key of ERROR_GUIDANCE_KEYS) expect(key).toMatch(/^[a-z][A-Za-z]+$/);
    for (const code of SUPPORTED_ERROR_CODES) {
      expect(guidanceKeyForCode(code)).not.toBeNull();
    }
  });
});
