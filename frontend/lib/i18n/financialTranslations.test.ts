import manifestJson from "../../i18n/financial-strings.json";
import glossaryJson from "../../i18n/glossary.json";
import reviewStateJson from "../../i18n/review-state.json";
import enJson from "../../messages/en.json";
import esJson from "../../messages/es.json";
import tlJson from "../../messages/tl.json";
import {
  applyReviewDecision,
  evaluateFinancialStrings,
  placeholdersIn,
  sourceHash,
  type FinancialStringManifest,
  type Glossary,
  type Messages,
  type ReviewAction,
  type ReviewState,
} from "./financialTranslations";

const manifest = manifestJson as FinancialStringManifest;
const glossary = glossaryJson as Glossary;
const sourceMessages = enJson as Messages;
const localizedMessages: Record<string, Messages> = {
  en: enJson as Messages,
  es: esJson as Messages,
  tl: tlJson as Messages,
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function evaluate(
  state: ReviewState = clone(reviewStateJson as ReviewState),
  messages = clone(localizedMessages),
) {
  return evaluateFinancialStrings({
    manifest,
    glossary,
    reviewState: state,
    sourceMessages,
    localizedMessages: messages,
  });
}

function withoutApproval(key: string, locale: string): ReviewState {
  const state = clone(reviewStateJson as ReviewState);
  state.approvals = state.approvals.filter((item) => !(item.key === key && item.locale === locale));
  return state;
}

describe("financial translation release gate", () => {
  it("passes when every critical string has a current reviewer approval", () => {
    const result = evaluate();
    expect(result.blocked).toBe(false);
    expect(result.findings).toEqual([]);
    expect(result.approved).toBe(result.checked);
  });

  it("blocks a missing critical translation", () => {
    const messages = clone(localizedMessages);
    delete (messages.es.LoanCard as Record<string, unknown>).totalOwed;
    const result = evaluate(undefined, messages);
    expect(result.blocked).toBe(true);
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        code: "missing_translation",
        key: "LoanCard.totalOwed",
        locale: "es",
      }),
    );
  });

  it("blocks an unapproved critical string", () => {
    const result = evaluate(withoutApproval("LoanCard.principal", "tl"));
    expect(result.blocked).toBe(true);
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        code: "unapproved_string",
        key: "LoanCard.principal",
        locale: "tl",
      }),
    );
  });

  it("blocks an approval bound to an older source revision", () => {
    const state = clone(reviewStateJson as ReviewState);
    const approval = state.approvals.find(
      (item) => item.key === "LoanCard.totalOwed" && item.locale === "es",
    );
    expect(approval).toBeDefined();
    approval!.sourceHash = "deadbeef";
    const result = evaluate(state);
    expect(result.findings).toContainEqual(
      expect.objectContaining({ code: "stale_approval", key: "LoanCard.totalOwed", locale: "es" }),
    );
  });

  it("blocks changed placeholders and drifted source text", () => {
    const messages = clone(localizedMessages);
    (messages.tl.LoanCard as Record<string, unknown>).daysRemaining = "na araw na natitira";
    const drifted = {
      ...sourceMessages,
      LoanCard: { ...(sourceMessages.LoanCard as object), totalOwed: "Amount Due" },
    };
    const result = evaluateFinancialStrings({
      manifest,
      glossary,
      reviewState: clone(reviewStateJson as ReviewState),
      sourceMessages: drifted,
      localizedMessages: messages,
    });
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        code: "placeholder_mismatch",
        key: "LoanCard.daysRemaining",
        locale: "tl",
      }),
    );
    expect(result.findings).toContainEqual(
      expect.objectContaining({ code: "source_drift", key: "LoanCard.totalOwed", locale: "en" }),
    );
  });

  it("blocks source fallback when no glossary exemption or current approval applies", () => {
    const messages = clone(localizedMessages);
    (messages.es.LoanCard as Record<string, unknown>).accruedInterest = "Accrued Interest";
    const result = evaluate(withoutApproval("LoanCard.accruedInterest", "es"), messages);
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        code: "inconsistent_fallback",
        key: "LoanCard.accruedInterest",
        locale: "es",
      }),
    );
  });

  it("extracts and normalizes placeholders", () => {
    expect(placeholdersIn("Due {date} — Loan #{loanId} {date}")).toEqual(["date", "loanId"]);
  });

  it("fingerprints the source, context, and glossary binding", () => {
    const entry = manifest.criticalStrings[0];
    expect(sourceHash(entry)).toHaveLength(8);
    expect(sourceHash(entry)).toBe(sourceHash(clone(entry)));
    expect(sourceHash({ ...entry, context: "Changed context" })).not.toBe(sourceHash(entry));
  });
});

describe("review decision workflow", () => {
  const base = {
    state: clone(reviewStateJson as ReviewState),
    manifest,
    key: "LoanCard.principal",
    locale: "es",
    action: "approve" as ReviewAction,
    reviewer: "reviewer-1",
    now: "2026-11-22T10:00:00.000Z",
  };

  it("rejects unauthorized, unknown, and stale actions without changing state", () => {
    const unauthorized = applyReviewDecision({ ...base, role: "borrower" });
    expect(unauthorized).toMatchObject({ ok: false, code: "unauthorized_reviewer" });

    const unknownKey = applyReviewDecision({ ...base, role: "admin", key: "Missing.key" });
    expect(unknownKey).toMatchObject({ ok: false, code: "unknown_key" });

    const sourceLocale = applyReviewDecision({ ...base, role: "admin", locale: "en" });
    expect(sourceLocale).toMatchObject({ ok: false, code: "source_locale" });

    const missingReviewer = applyReviewDecision({ ...base, role: "admin", reviewer: "  " });
    expect(missingReviewer).toMatchObject({ ok: false, code: "missing_reviewer" });

    const stale = applyReviewDecision({ ...base, role: "admin", expectedSourceHash: "deadbeef" });
    expect(stale).toMatchObject({ ok: false, code: "stale_action" });

    const invalid = applyReviewDecision({
      ...base,
      state: clone(reviewStateJson as ReviewState),
      role: "admin",
      action: "invalid" as ReviewAction,
    });
    expect(invalid).toMatchObject({ ok: false, code: "invalid_action" });
  });

  it("approves an already-approved string idempotently", () => {
    const result = applyReviewDecision({
      ...base,
      role: "admin",
      action: "approve",
      reviewer: "localization-admin",
    });
    expect(result).toMatchObject({ ok: true, changed: false });
    if (result.ok) expect(result.state).toBe(base.state);
  });

  it("rejects and then re-approves a string in one immutable transition each", () => {
    const rejected = applyReviewDecision({ ...base, role: "admin", action: "reject" });
    expect(rejected.ok).toBe(true);
    if (!rejected.ok) return;
    expect(rejected.changed).toBe(true);
    expect(rejected.state.approvals).toHaveLength(base.state.approvals.length);

    const approved = applyReviewDecision({
      ...base,
      state: rejected.state,
      role: "admin",
      action: "approve",
      reviewer: "reviewer-2",
      now: "2026-11-22T11:00:00.000Z",
    });
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    expect(approved.changed).toBe(true);
    expect(approved.approval).toMatchObject({
      status: "approved",
      reviewer: "reviewer-2",
      role: "admin",
    });
    expect(
      base.state.approvals.find((item) => item.key === base.key && item.locale === base.locale)
        ?.status,
    ).toBe("approved");
  });
});
