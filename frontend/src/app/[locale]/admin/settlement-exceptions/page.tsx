"use client";

import { useEffect } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { AlertTriangle, ExternalLink, RefreshCw } from "lucide-react";
import { useAdminSettlementExceptions, useVerifySession } from "../../../hooks/useApi";
import { useUserStore } from "../../../stores/useUserStore";

export default function SettlementExceptionsPage() {
  const t = useTranslations("SettlementExceptions");
  const locale = useLocale();
  const router = useRouter();
  const token = useUserStore((state) => state.authToken);
  const user = useUserStore((state) => state.user);
  const session = useVerifySession({ enabled: Boolean(token) });
  const role = session.data?.role ?? user?.role;
  const isChecking = Boolean(token) && !role && session.isLoading;
  const isAdmin = role === "admin";
  const exceptionsQuery = useAdminSettlementExceptions({ enabled: isAdmin });

  useEffect(() => {
    if (!token || (!isChecking && !isAdmin)) {
      router.replace(`/${locale}`);
    }
  }, [isAdmin, isChecking, locale, router, token]);

  const typeLabels = {
    delayed: t("types.delayed"),
    duplicate: t("types.duplicate"),
    mismatched: t("types.mismatched"),
    unresolved: t("types.unresolved"),
  };
  const ageLabels = {
    under_1h: t("ages.under1h"),
    "1h_24h": t("ages.1h24h"),
    "1d_7d": t("ages.1d7d"),
    over_7d: t("ages.over7d"),
  };

  if (isChecking || !isAdmin) {
    return <p className="text-sm text-zinc-500 dark:text-zinc-400">{t("checkingAccess")}</p>;
  }

  return (
    <section className="space-y-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-indigo-600">
            {t("eyebrow")}
          </p>
          <h1 className="text-3xl font-bold text-zinc-900 dark:text-zinc-50">{t("title")}</h1>
          <p className="mt-2 max-w-3xl text-sm text-zinc-500 dark:text-zinc-400">
            {t("description")}
          </p>
        </div>
        <button
          type="button"
          onClick={() => exceptionsQuery.refetch()}
          className="inline-flex items-center gap-2 rounded-lg border border-zinc-200 px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-900"
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          {t("refresh")}
        </button>
      </header>

      {exceptionsQuery.isLoading ? (
        <div className="rounded-2xl border border-zinc-200 bg-white p-6 text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
          {t("loading")}
        </div>
      ) : exceptionsQuery.isError ? (
        <div
          role="alert"
          className="rounded-2xl border border-red-200 bg-red-50 p-6 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
        >
          <AlertTriangle className="mb-2 h-5 w-5" aria-hidden="true" />
          {t("error")}
        </div>
      ) : (
        <>
          <section aria-label={t("summary")} className="space-y-3">
            <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
              {t("summary")}
            </h2>
            {(exceptionsQuery.data?.summary ?? []).length === 0 ? (
              <p className="rounded-2xl border border-dashed border-zinc-300 p-6 text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
                {t("empty")}
              </p>
            ) : (
              <div className="overflow-x-auto rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
                <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
                  <thead className="bg-zinc-50 text-left text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                    <tr>
                      <th className="px-4 py-3">{t("columns.type")}</th>
                      <th className="px-4 py-3">{t("columns.source")}</th>
                      <th className="px-4 py-3">{t("columns.age")}</th>
                      <th className="px-4 py-3 text-right">{t("columns.count")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                    {exceptionsQuery.data?.summary.map((row) => (
                      <tr key={`${row.exceptionType}:${row.source}:${row.ageBucket}`}>
                        <td className="px-4 py-3 font-medium text-zinc-900 dark:text-zinc-50">
                          {typeLabels[row.exceptionType]}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-zinc-700 dark:text-zinc-300">
                          {row.source}
                        </td>
                        <td className="px-4 py-3 text-zinc-600 dark:text-zinc-300">
                          {ageLabels[row.ageBucket]}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums text-zinc-900 dark:text-zinc-50">
                          {row.count}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section aria-label={t("drilldown")} className="space-y-3">
            <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
              {t("drilldown")}
            </h2>
            <div className="overflow-x-auto rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
              <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
                <thead className="bg-zinc-50 text-left text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                  <tr>
                    <th className="px-4 py-3">{t("columns.type")}</th>
                    <th className="px-4 py-3">{t("columns.subject")}</th>
                    <th className="px-4 py-3">{t("columns.status")}</th>
                    <th className="px-4 py-3">{t("columns.detected")}</th>
                    <th className="px-4 py-3">{t("columns.recovery")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {(exceptionsQuery.data?.exceptions ?? []).map((exception) => (
                    <tr key={`${exception.subjectRef}:${exception.exceptionType}`}>
                      <td className="whitespace-nowrap px-4 py-3 font-medium text-zinc-900 dark:text-zinc-50">
                        {typeLabels[exception.exceptionType]}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-zinc-700 dark:text-zinc-300">
                        {exception.subjectRef}
                      </td>
                      <td className="px-4 py-3 text-zinc-600 dark:text-zinc-300">
                        {exception.status}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-zinc-600 dark:text-zinc-300">
                        {new Intl.DateTimeFormat(locale, {
                          dateStyle: "medium",
                          timeStyle: "short",
                        }).format(new Date(exception.detectedAt))}
                      </td>
                      <td className="px-4 py-3">
                        <a
                          href={exception.recoveryProcedure}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                        >
                          {t("openProcedure")}
                          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                        </a>
                      </td>
                    </tr>
                  ))}
                  {(exceptionsQuery.data?.exceptions ?? []).length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-4 py-8 text-center text-zinc-500">
                        {t("noDetails")}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">{t("detailsLimit")}</p>
          </section>
        </>
      )}
    </section>
  );
}
