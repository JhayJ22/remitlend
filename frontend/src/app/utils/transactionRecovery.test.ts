import {
  createRecoverySupportCode,
  planRecoveryFromDetails,
  planTransactionRecovery,
} from "./transactionRecovery";
import { mapTransactionError } from "./transactionErrors";

const HASH = "a".repeat(64);

describe("planTransactionRecovery — rejected signatures", () => {
  it("treats a wallet rejection as a user action, not a failure", () => {
    const plan = planTransactionRecovery(new Error("User rejected the request"));
    expect(plan.state).toBe("rejected");
    expect(plan.headline).toBe("You declined this request");
    expect(plan.safeToResubmit).toBe(true);
    expect(plan.resubmitWarning).toBeNull();
  });

  it("leads with a re-sign action that does not charge anything", () => {
    const plan = planTransactionRecovery(new Error("Request denied by user"));
    const primary = plan.actions.filter((a) => a.variant === "primary");
    expect(primary).toHaveLength(1);
    expect(primary[0].id).toBe("retry_signing");
    expect(primary[0].requiresSignature).toBe(true);
    expect(plan.actions.map((a) => a.id)).toContain("contact_support");
  });

  it("says nothing was sent", () => {
    const plan = planTransactionRecovery(new Error("User cancelled signing"));
    expect(plan.steps.join(" ")).toMatch(/Nothing was signed and nothing was sent/);
  });
});

describe("planTransactionRecovery — expired requests", () => {
  it("classifies expiry separately from a timeout", () => {
    const plan = planTransactionRecovery(new Error("Transaction has expired"));
    expect(plan.state).toBe("expired");
    expect(plan.headline).toBe("This request expired");
    expect(plan.safeToResubmit).toBe(true);
  });

  it("classifies an expired authentication challenge as expired", () => {
    const plan = planTransactionRecovery({ code: "CHALLENGE_EXPIRED", message: "expired" });
    expect(plan.state).toBe("expired");
  });

  it("tells the borrower to start fresh rather than resubmit a dead envelope", () => {
    const plan = planTransactionRecovery(new Error("tx_bad_seq: transaction expired"));
    expect(plan.steps.join(" ")).toMatch(/expired one can no longer be submitted/);
  });
});

describe("planTransactionRecovery — double-submission safety", () => {
  it("forbids resubmission once a transaction has been submitted", () => {
    const plan = planTransactionRecovery(new Error("Network timeout while polling status"), {
      txHash: HASH,
      submitted: true,
    });

    expect(plan.safeToResubmit).toBe(false);
    expect(plan.resubmitWarning).toContain("duplicate loan");
    expect(plan.resubmitWarning).toContain(HASH.slice(0, 8));
  });

  it("offers tracking, not signing, as the primary action", () => {
    const plan = planTransactionRecovery(new Error("Network timeout while polling status"), {
      txHash: HASH,
      submitted: true,
    });
    const primary = plan.actions.filter((a) => a.variant === "primary");
    expect(primary.map((a) => a.id)).toEqual(["resume_tracking"]);
    expect(primary[0].requiresSignature).toBe(false);
  });

  it("never offers a signature-requiring action after submission", () => {
    const plan = planTransactionRecovery(new Error("Network timeout"), {
      txHash: HASH,
      submitted: true,
    });
    expect(plan.actions.some((a) => a.requiresSignature)).toBe(false);
  });

  it("offers explorer and copy actions only when a hash exists", () => {
    const withHash = planTransactionRecovery(new Error("Network timeout"), { txHash: HASH });
    expect(withHash.actions.map((a) => a.id)).toEqual(
      expect.arrayContaining(["check_explorer", "copy_tx_hash"]),
    );
    expect(withHash.preserveTxHash).toBe(true);

    const withoutHash = planTransactionRecovery(new Error("Network timeout"));
    expect(withoutHash.actions.map((a) => a.id)).not.toContain("check_explorer");
    expect(withoutHash.preserveTxHash).toBe(false);
  });

  it("treats submitted=true without a hash as still unsafe to resubmit", () => {
    const plan = planTransactionRecovery(new Error("Network timeout"), { submitted: true });
    expect(plan.safeToResubmit).toBe(false);
    expect(plan.actions.map((a) => a.id)).toEqual([
      "resume_tracking",
      "reload_page",
      "contact_support",
    ]);
  });
});

describe("planTransactionRecovery — other failure categories", () => {
  it("does not offer an automatic retry for insufficient balance", () => {
    const plan = planTransactionRecovery(new Error("Insufficient balance in account"));
    expect(plan.safeToResubmit).toBe(true);
    expect(plan.actions.map((a) => a.id)).not.toContain("resubmit");
    expect(plan.actions.map((a) => a.id)).toContain("reconnect_wallet");
  });

  it("does not offer a retry for a low credit score", () => {
    const plan = planTransactionRecovery(new Error("score too low"));
    expect(plan.actions.map((a) => a.id)).not.toContain("resubmit");
    expect(plan.steps.join(" ")).toMatch(/credit score/i);
  });

  it("does not offer a blind retry after an on-chain failure", () => {
    const plan = planTransactionRecovery(new Error("Transaction failed on-chain: revert"));
    expect(plan.safeToResubmit).toBe(true);
    expect(plan.actions.map((a) => a.id)).not.toContain("resubmit");
  });

  it("stays conservative for an unrecognised error", () => {
    const plan = planTransactionRecovery(new Error("kaboom"));
    expect(plan.state).toBe("unknown");
    expect(plan.safeToResubmit).toBe(true);
    expect(plan.actions.map((a) => a.id)).toContain("reload_page");
  });

  it("handles non-Error values without throwing", () => {
    for (const value of [undefined, null, 42, { nope: true }, ""]) {
      expect(() => planTransactionRecovery(value)).not.toThrow();
    }
  });
});

describe("support code", () => {
  it("encodes only the category, a truncated hash and the attempt", () => {
    const code = createRecoverySupportCode("network_timeout", HASH, 2);
    expect(code).toBe(`NETWORK_TIMEOUT-${HASH.slice(0, 8).toUpperCase()}-02`);
    expect(code).not.toContain(HASH);
  });

  it("marks a missing hash", () => {
    expect(createRecoverySupportCode("expired")).toMatch(/NOHASH/);
  });

  it("bounds the attempt counter and the category length", () => {
    expect(createRecoverySupportCode("x".repeat(200), null, 10_000)).toMatch(/X{16}-NOHASH-999$/);
    expect(createRecoverySupportCode("x", null, -3)).toMatch(/-01$/);
  });

  it("is included in the plan steps", () => {
    const plan = planTransactionRecovery(new Error("expired"));
    expect(plan.steps[plan.steps.length - 1]).toContain(plan.supportCode);
  });
});

describe("planRecoveryFromDetails", () => {
  it("preserves the already-mapped message instead of re-deriving it", () => {
    const details = mapTransactionError("Network timeout while polling status");
    const plan = planRecoveryFromDetails(details, { txHash: HASH, submitted: true });
    expect(plan.category).toBe(details.category);
    expect(plan.summary).toBe(details.message);
  });

  it("treats a still-pending transaction as unsafe to resubmit", () => {
    const details = mapTransactionError("Network timeout while polling status");
    const plan = planRecoveryFromDetails(details, { txHash: HASH });
    expect(plan.safeToResubmit).toBe(false);
    expect(plan.steps[0]).toMatch(/sent to the network/);
  });
});
