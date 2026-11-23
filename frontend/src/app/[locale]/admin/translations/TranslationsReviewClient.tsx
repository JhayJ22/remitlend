"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import {
  evaluateFinancialStrings,
  sourceHash,
  type FinancialStringManifest,
  type Glossary,
  type Messages,
  type ReviewState,
} from "../../../../../lib/i18n/financialTranslations";
import { useUserStore } from "../../../stores/useUserStore";

interface TranslationsReviewClientProps {
  manifest: FinancialStringManifest;
  glossary: Glossary;
  initialReviewState: ReviewState;
  sourceMessages: Messages;
  localizedMessages: Record<string, Messages>;
}

export default function TranslationsReviewClient({
  manifest,
  glossary,
  initialReviewState,
  sourceMessages,
  localizedMessages,
}: TranslationsReviewClientProps) {
  const t = useTranslations("TranslationReview");
  const role = useUserStore((state) => state.user?.role);
  const authToken = useUserStore((state) => state.authToken);
  const [reviewState, setReviewState] = useState(initialReviewState);
  const [locale, setLocale] = useState(manifest.locales.find((item) => item !== "en") ?? "es");
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const evaluation = useMemo(
    () =>
      evaluateFinancialStrings({
        manifest,
        glossary,
        reviewState,
        sourceMessages,
        localizedMessages,
      }),
    [manifest, glossary, reviewState, sourceMessages, localizedMessages],
  );

  const glossaryTerms = useMemo(
    () => new Map(glossary.terms.map((term) => [term.id, term])),
    [glossary],
  );
  const approvalFor = (key: string) =>
    reviewState.approvals
      .filter((approval) => approval.key === key && approval.locale === locale)
      .sort((left, right) => right.reviewedAt.localeCompare(left.reviewedAt))[0];

  async function submit(action: "approve" | "reject", key: string) {
    const entry = manifest.criticalStrings.find((item) => item.key === key);
    if (!entry || !authToken) return;
    setPendingKey(key);
    setNotice("");
    setError("");
    try {
      const response = await fetch("/api/i18n/reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ key, locale, action, expectedSourceHash: sourceHash(entry) }),
      });
      const payload = (await response.json()) as { error?: string; reviewState?: ReviewState };
      if (!response.ok || !payload.reviewState) {
        setError(payload.error ?? t("error"));
        return;
      }
      setReviewState(payload.reviewState);
      setNotice(t("updated"));
    } catch {
      setError(t("error"));
    } finally {
      setPendingKey(null);
    }
  }

  if (role !== "admin") {
    return (
      <main className="mx-auto max-w-5xl px-4 py-10">
        <div className="rounded-2xl border border-red-200 bg-red-50 p-6 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {t("forbidden")}
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-7xl space-y-6 px-4 py-10">
      <header>
        <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
          {t("eyebrow")}
        </p>
        <h1 className="mt-1 text-2xl font-semibold text-zinc-950 dark:text-zinc-50">
          {t("title")}
        </h1>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">{t("description")}</p>
      </header>

      <section aria-live="polite" className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <span
            className={`rounded-full px-3 py-1 text-sm font-medium ${
              evaluation.blocked
                ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300"
                : "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
            }`}
          >
            {evaluation.blocked ? t("releaseBlocked") : t("releaseReady")}
          </span>
          <span className="text-sm text-zinc-500 dark:text-zinc-400">
            {t("reviewed", { approved: evaluation.approved, checked: evaluation.checked })}
          </span>
        </div>
        {evaluation.blocked ? (
          <ul className="list-disc space-y-1 pl-5 text-sm text-red-700 dark:text-red-300">
            {evaluation.findings.map((finding, index) => (
              <li key={`${finding.locale}-${finding.key}-${finding.code}-${index}`}>
                {finding.locale} / {finding.key}: {finding.message}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">{t("noIssues")}</p>
        )}
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <label
          htmlFor="review-locale"
          className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
        >
          {t("locale")}
        </label>
        <select
          id="review-locale"
          value={locale}
          onChange={(event) => setLocale(event.target.value)}
          className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        >
          {manifest.locales
            .filter((item) => item !== "en")
            .map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
        </select>
      </div>

      <p aria-live="polite" className="min-h-6 text-sm text-emerald-700 dark:text-emerald-300">
        {notice}
      </p>
      <p aria-live="assertive" className="min-h-6 text-sm text-red-700 dark:text-red-300">
        {error}
      </p>

      <div className="overflow-x-auto rounded-2xl border border-zinc-200 dark:border-zinc-800">
        <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
          <caption className="sr-only">{t("title")}</caption>
          <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
            <tr>
              <th scope="col" className="px-4 py-3">
                {t("key")}
              </th>
              <th scope="col" className="px-4 py-3">
                {t("source")}
              </th>
              <th scope="col" className="px-4 py-3">
                {t("translation")}
              </th>
              <th scope="col" className="px-4 py-3">
                {t("context")}
              </th>
              <th scope="col" className="px-4 py-3">
                {t("glossary")}
              </th>
              <th scope="col" className="px-4 py-3">
                {t("status")}
              </th>
              <th scope="col" className="px-4 py-3">
                {t("actions")}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
            {manifest.criticalStrings.map((entry) => {
              const approval = approvalFor(entry.key);
              const current = approval?.sourceHash === sourceHash(entry);
              const status =
                !approval || approval.status === "pending" ? t("pending") : t(approval.status);
              return (
                <tr key={entry.key} className="align-top">
                  <th scope="row" className="px-4 py-3 text-left font-mono text-xs">
                    {entry.key}
                  </th>
                  <td className="px-4 py-3">{entry.source}</td>
                  <td className="px-4 py-3">
                    {String(localizedMessages[locale]?.[entry.key] ?? t("none"))}
                  </td>
                  <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400">{entry.context}</td>
                  <td className="px-4 py-3">
                    {entry.glossaryTermIds
                      .map(
                        (id) =>
                          glossaryTerms.get(id)?.renderings[locale] ??
                          glossaryTerms.get(id)?.source ??
                          id,
                      )
                      .join(", ")}
                  </td>
                  <td className="px-4 py-3">
                    <span>{status}</span>
                    {approval && (
                      <span className="mt-1 block text-xs text-zinc-500 dark:text-zinc-400">
                        {approval.reviewer} · {approval.reviewedAt}
                      </span>
                    )}
                    {approval && !current && (
                      <span className="mt-1 block text-xs text-amber-700 dark:text-amber-300">
                        {t("stale")}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={pendingKey === entry.key}
                        onClick={() => void submit("approve", entry.key)}
                        className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                        aria-label={`${t("approve")} ${entry.key}`}
                      >
                        {current && approval?.status === "approved" ? t("update") : t("approve")}
                      </button>
                      <button
                        type="button"
                        disabled={pendingKey === entry.key}
                        onClick={() => void submit("reject", entry.key)}
                        className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium disabled:opacity-50 dark:border-zinc-700"
                        aria-label={`${t("reject")} ${entry.key}`}
                      >
                        {t("reject")}
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </main>
  );
}
