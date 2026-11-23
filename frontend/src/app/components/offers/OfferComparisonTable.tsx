"use client";

import { useEffect, useId, useMemo, useReducer, useRef } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Loan, PoolStats } from "../../hooks/useApi";
import {
  applyOfferTableAction,
  initialOfferTableState,
  selectOfferRows,
  type OfferRow,
  type OfferSortKey,
} from "../../../lib/offerComparison";
import { buildOfferRows } from "../../../lib/offerRows";

interface OfferComparisonTableProps {
  loans: readonly Loan[];
  poolStats?: PoolStats;
  isLoading?: boolean;
  isError?: boolean;
}

const SORT_KEYS: readonly OfferSortKey[] = [
  "name",
  "kind",
  "amount",
  "ratePercent",
  "termDays",
  "status",
];

function formatMoney(value: number, currency: string, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

export function OfferComparisonTable({
  loans,
  poolStats,
  isLoading = false,
  isError = false,
}: OfferComparisonTableProps) {
  const t = useTranslations("Offers");
  const locale = useLocale();
  const [state, dispatch] = useReducer(applyOfferTableAction, initialOfferTableState);
  const pendingSortFocus = useRef<OfferSortKey | null>(null);
  const sortButtons = useRef<Partial<Record<OfferSortKey, HTMLButtonElement | null>>>({});
  const headingId = useId();
  const summaryId = useId();

  const rows = useMemo(
    () => buildOfferRows(loans, poolStats, (id) => t("loanName", { id }), t("poolName")),
    [loans, poolStats, t],
  );
  const visibleRows = useMemo(() => selectOfferRows(rows, state), [rows, state]);

  useEffect(() => {
    const key = pendingSortFocus.current;
    if (!key) return;
    sortButtons.current[key]?.focus();
    pendingSortFocus.current = null;
  }, [state.revision, state.sortKey, state.direction]);

  const filterSummary = [
    `${t("filters.currencyLabel")}: ${state.filters.currency === "all" ? t("filters.all") : state.filters.currency}`,
    `${t("filters.kindLabel")}: ${t(`filters.${state.filters.kind}`)}`,
    `${t("filters.statusLabel")}: ${state.filters.status === "all" ? t("filters.all") : state.filters.status}`,
    state.filters.query ? `${t("filters.searchLabel")}: ${state.filters.query}` : null,
  ]
    .filter(Boolean)
    .join("; ");

  const summary = t("summary", {
    visible: visibleRows.length,
    total: rows.length,
    column: t(`columns.${state.sortKey}`),
    direction: t(state.direction === "asc" ? "sortAscending" : "sortDescending"),
    filters: filterSummary,
  });

  const handleSort = (key: OfferSortKey) => {
    pendingSortFocus.current = key;
    dispatch({ type: "sort", key });
  };

  const cellValue = (row: OfferRow, key: OfferSortKey): string => {
    if (key === "amount") return formatMoney(row.amount, row.currency, locale);
    if (key === "ratePercent") return t("rate", { value: row.ratePercent.toFixed(2) });
    if (key === "termDays") {
      return row.termDays === null ? t("termNone") : `${row.termDays}`;
    }
    return key === "kind" ? t(`filters.${row.kind}`) : row[key];
  };

  return (
    <section aria-labelledby={headingId} className="space-y-4">
      <div>
        <h2 id={headingId} className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">
          {t("title")}
        </h2>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{t("description")}</p>
      </div>

      {isLoading ? (
        <p role="status" className="text-sm text-zinc-500 dark:text-zinc-400">
          {t("states.loading")}
        </p>
      ) : null}

      {isError ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {t("states.error")}
        </p>
      ) : null}

      {!isLoading && !isError ? (
        <>
          <div className="grid gap-3 rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <label
                htmlFor={`${headingId}-query`}
                className="text-xs font-medium text-zinc-700 dark:text-zinc-300"
              >
                {t("filters.searchLabel")}
              </label>
              <input
                id={`${headingId}-query`}
                type="search"
                value={state.filters.query}
                onChange={(event) =>
                  dispatch({ type: "filter", key: "query", value: event.target.value })
                }
                placeholder={t("filters.searchPlaceholder")}
                className="mt-1 w-full rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-900"
              />
            </div>
            <div>
              <label
                htmlFor={`${headingId}-currency`}
                className="text-xs font-medium text-zinc-700 dark:text-zinc-300"
              >
                {t("filters.currencyLabel")}
              </label>
              <select
                id={`${headingId}-currency`}
                value={state.filters.currency}
                onChange={(event) =>
                  dispatch({ type: "filter", key: "currency", value: event.target.value })
                }
                className="mt-1 w-full rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-900"
              >
                <option value="all">{t("filters.all")}</option>
                {[...new Set(rows.map((row) => row.currency))].map((currency) => (
                  <option key={currency} value={currency}>
                    {currency}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label
                htmlFor={`${headingId}-kind`}
                className="text-xs font-medium text-zinc-700 dark:text-zinc-300"
              >
                {t("filters.kindLabel")}
              </label>
              <select
                id={`${headingId}-kind`}
                value={state.filters.kind}
                onChange={(event) =>
                  dispatch({ type: "filter", key: "kind", value: event.target.value })
                }
                className="mt-1 w-full rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-900"
              >
                {(["all", "loan", "pool"] as const).map((kind) => (
                  <option key={kind} value={kind}>
                    {t(`filters.${kind}`)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label
                htmlFor={`${headingId}-status`}
                className="text-xs font-medium text-zinc-700 dark:text-zinc-300"
              >
                {t("filters.statusLabel")}
              </label>
              <select
                id={`${headingId}-status`}
                value={state.filters.status}
                onChange={(event) =>
                  dispatch({ type: "filter", key: "status", value: event.target.value })
                }
                className="mt-1 w-full rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-900"
              >
                <option value="all">{t("filters.all")}</option>
                {[...new Set(rows.map((row) => row.status))].map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <p
            id={summaryId}
            role="status"
            aria-live="polite"
            className="text-sm text-zinc-600 dark:text-zinc-300"
          >
            {summary}
          </p>
          {state.notice === "invalid" ? (
            <p role="status" className="text-xs text-amber-600 dark:text-amber-400">
              {t("states.invalid")}
            </p>
          ) : null}

          {visibleRows.length === 0 ? (
            <p role="status" className="text-sm text-zinc-500 dark:text-zinc-400">
              {t("states.empty")}
            </p>
          ) : (
            <>
              <div className="hidden overflow-x-auto rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950 md:block">
                <table className="w-full border-collapse text-sm" aria-describedby={summaryId}>
                  <caption className="sr-only">{t("caption")}</caption>
                  <thead>
                    <tr className="border-b border-zinc-200 dark:border-zinc-800">
                      {SORT_KEYS.map((key) => {
                        const active = state.sortKey === key;
                        return (
                          <th
                            key={key}
                            scope="col"
                            aria-sort={
                              active
                                ? state.direction === "asc"
                                  ? "ascending"
                                  : "descending"
                                : "none"
                            }
                            className="px-4 py-3 text-left font-semibold text-zinc-700 dark:text-zinc-200"
                          >
                            <button
                              type="button"
                              ref={(node) => {
                                sortButtons.current[key] = node;
                              }}
                              onClick={() => handleSort(key)}
                              aria-label={`${t(`columns.${key}`)}. ${t("sortAction")}`}
                              className="rounded px-1 py-0.5 hover:bg-zinc-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:hover:bg-zinc-800"
                            >
                              {t(`columns.${key}`)}
                              {active ? (state.direction === "asc" ? " ▲" : " ▼") : ""}
                            </button>
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRows.map((row) => (
                      <tr
                        key={row.id}
                        className="border-b border-zinc-100 last:border-0 dark:border-zinc-900"
                      >
                        <th scope="row" className="px-4 py-3 text-left font-medium">
                          {row.name}
                          <span className="sr-only"> ({row.id})</span>
                        </th>
                        <td className="px-4 py-3">{cellValue(row, "kind")}</td>
                        <td className="px-4 py-3 tabular-nums">{cellValue(row, "amount")}</td>
                        <td className="px-4 py-3 tabular-nums">{cellValue(row, "ratePercent")}</td>
                        <td className="px-4 py-3 tabular-nums">{cellValue(row, "termDays")}</td>
                        <td className="px-4 py-3">{cellValue(row, "status")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="space-y-3 md:hidden" aria-describedby={summaryId}>
                {visibleRows.map((row) => (
                  <article
                    key={row.id}
                    className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950"
                  >
                    <h3 className="font-semibold text-zinc-900 dark:text-zinc-50">{row.name}</h3>
                    <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                      {SORT_KEYS.filter((key) => key !== "name").map((key) => (
                        <div key={key}>
                          <dt className="text-xs text-zinc-500 dark:text-zinc-400">
                            {t(`columns.${key}`)}
                          </dt>
                          <dd className="text-zinc-800 dark:text-zinc-100">
                            {cellValue(row, key)}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </article>
                ))}
              </div>
            </>
          )}
        </>
      ) : null}
    </section>
  );
}
