export type Locale = string;
export type CriticalCategory = "money" | "loan-term";
export type ReviewStatus = "approved" | "pending" | "rejected";
export type ReviewAction = "approve" | "reject";

export interface CriticalString {
  key: string;
  category: CriticalCategory;
  source: string;
  context: string;
  glossaryTermIds: string[];
  placeholders: string[];
  unit: string;
}

export interface GlossaryTerm {
  id: string;
  source: string;
  definition: string;
  doNotTranslate: boolean;
  renderings: Record<string, string>;
}

export interface Approval {
  key: string;
  locale: Locale;
  status: ReviewStatus;
  sourceHash: string;
  reviewer: string;
  role: string;
  reviewedAt: string;
}

export interface FinancialStringManifest {
  version: number;
  locales: Locale[];
  reviewerRole: string;
  criticalStrings: CriticalString[];
}

export interface Glossary {
  version: number;
  terms: GlossaryTerm[];
}

export interface ReviewState {
  version: number;
  approvals: Approval[];
}

export type Messages = Record<string, unknown>;

export type FindingCode =
  | "source_drift"
  | "missing_translation"
  | "unapproved_string"
  | "stale_approval"
  | "placeholder_mismatch"
  | "inconsistent_fallback"
  | "unknown_glossary_term";

export type ReviewErrorCode =
  | "unknown_key"
  | "unknown_locale"
  | "source_locale"
  | "unauthorized_reviewer"
  | "missing_reviewer"
  | "stale_action"
  | "invalid_action";

export interface Finding {
  code: FindingCode;
  key: string;
  locale: Locale;
  message: string;
}

export interface Evaluation {
  blocked: boolean;
  checked: number;
  approved: number;
  findings: Finding[];
}

export type ReviewResult =
  | { ok: true; state: ReviewState; changed: boolean; approval: Approval }
  | { ok: false; code: ReviewErrorCode; message: string };

const PLACEHOLDER_PATTERN = /\{([A-Za-z0-9_]+)\}/g;

export function sourceHash(entry: CriticalString): string {
  const input = JSON.stringify({
    source: entry.source,
    context: entry.context,
    placeholders: entry.placeholders,
    glossaryTermIds: entry.glossaryTermIds,
  });
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function placeholdersIn(value: string): string[] {
  return [...new Set([...value.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[1]))].sort();
}

export function lookupMessage(messages: Messages, key: string): string | undefined {
  const value = key.split(".").reduce<unknown>((current, part) => {
    if (current && typeof current === "object") {
      return (current as Record<string, unknown>)[part];
    }
    return undefined;
  }, messages);
  return typeof value === "string" ? value : undefined;
}

function latestApproval(state: ReviewState, key: string, locale: Locale): Approval | undefined {
  return state.approvals
    .filter((approval) => approval.key === key && approval.locale === locale)
    .sort((left, right) => right.reviewedAt.localeCompare(left.reviewedAt))[0];
}

export function evaluateFinancialStrings(input: {
  manifest: FinancialStringManifest;
  glossary: Glossary;
  reviewState: ReviewState;
  sourceMessages: Messages;
  localizedMessages: Record<Locale, Messages>;
}): Evaluation {
  const { manifest, glossary, reviewState, sourceMessages, localizedMessages } = input;
  const findings: Finding[] = [];
  const glossaryTerms = new Map(glossary.terms.map((term) => [term.id, term]));
  const locales = manifest.locales.filter((locale) => locale !== "en");
  let checked = 0;
  let approved = 0;

  const add = (code: FindingCode, key: string, locale: Locale, message: string) => {
    findings.push({ code, key, locale, message });
  };

  for (const entry of manifest.criticalStrings) {
    const source = lookupMessage(sourceMessages, entry.key);
    if (source !== entry.source) {
      add(
        "source_drift",
        entry.key,
        "en",
        `Source text drifted from the approved manifest (${entry.source}).`,
      );
    }

    const missingTerms = entry.glossaryTermIds.filter((id) => !glossaryTerms.has(id));
    if (missingTerms.length > 0) {
      add(
        "unknown_glossary_term",
        entry.key,
        "en",
        `Unknown glossary term(s): ${missingTerms.join(", ")}.`,
      );
    }

    for (const locale of locales) {
      checked += 1;
      const localized = lookupMessage(localizedMessages[locale] ?? {}, entry.key);

      if (localized === undefined || localized.trim() === "") {
        add(
          "missing_translation",
          entry.key,
          locale,
          "Critical financial string is missing or empty.",
        );
        continue;
      }

      const found = placeholdersIn(localized);
      if (found.join(",") !== [...entry.placeholders].sort().join(",")) {
        add(
          "placeholder_mismatch",
          entry.key,
          locale,
          `Expected placeholders {${entry.placeholders.join("}, {")}}, found {${found.join("}, {")}}.`,
        );
      }

      const approval = latestApproval(reviewState, entry.key, locale);
      const hash = sourceHash(entry);
      if (!approval || approval.status !== "approved") {
        add(
          "unapproved_string",
          entry.key,
          locale,
          "Critical financial string has no current reviewer approval.",
        );
      } else if (approval.sourceHash !== hash) {
        add("stale_approval", entry.key, locale, "Approval is bound to an older source revision.");
      } else {
        approved += 1;
      }

      const allDoNotTranslate =
        entry.glossaryTermIds.length > 0 &&
        entry.glossaryTermIds.every((id) => glossaryTerms.get(id)?.doNotTranslate === true);
      if (localized === entry.source && !allDoNotTranslate && approval?.sourceHash !== hash) {
        add(
          "inconsistent_fallback",
          entry.key,
          locale,
          "Translation falls back to the source string without a glossary exemption or current approval.",
        );
      }
    }
  }

  return { blocked: findings.length > 0, checked, approved, findings };
}

export function applyReviewDecision(input: {
  state: ReviewState;
  manifest: FinancialStringManifest;
  key: string;
  locale: Locale;
  action: ReviewAction;
  reviewer: string;
  role: string;
  expectedSourceHash?: string;
  now?: string;
}): ReviewResult {
  const { state, manifest, key, locale, action, reviewer, role } = input;
  const entry = manifest.criticalStrings.find((candidate) => candidate.key === key);

  if (!entry) return { ok: false, code: "unknown_key", message: `Unknown critical string: ${key}` };
  if (!manifest.locales.includes(locale)) {
    return { ok: false, code: "unknown_locale", message: `Unsupported locale: ${locale}` };
  }
  if (locale === "en") {
    return { ok: false, code: "source_locale", message: "The source locale cannot be reviewed." };
  }
  if (role !== manifest.reviewerRole) {
    return {
      ok: false,
      code: "unauthorized_reviewer",
      message: `Only ${manifest.reviewerRole} reviewers may approve financial strings.`,
    };
  }
  if (reviewer.trim() === "") {
    return {
      ok: false,
      code: "missing_reviewer",
      message: "A reviewer identity is required for the audit trail.",
    };
  }
  if (action !== "approve" && action !== "reject") {
    return { ok: false, code: "invalid_action", message: "Action must be approve or reject." };
  }

  const hash = sourceHash(entry);
  if (input.expectedSourceHash !== undefined && input.expectedSourceHash !== hash) {
    return {
      ok: false,
      code: "stale_action",
      message: "The source changed since this review was opened.",
    };
  }

  const existing = latestApproval(state, key, locale);
  if (
    existing?.status === (action === "approve" ? "approved" : "rejected") &&
    existing.sourceHash === hash
  ) {
    return { ok: true, state, changed: false, approval: existing };
  }

  const approval: Approval = {
    key,
    locale,
    status: action === "approve" ? "approved" : "rejected",
    sourceHash: hash,
    reviewer,
    role,
    reviewedAt: input.now ?? new Date().toISOString(),
  };

  return {
    ok: true,
    state: {
      ...state,
      approvals: [
        ...state.approvals.filter((item) => !(item.key === key && item.locale === locale)),
        approval,
      ],
    },
    changed: true,
    approval,
  };
}
