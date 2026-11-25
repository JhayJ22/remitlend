"use client";

import { useEffect, useState } from "react";

interface ExceptionBucket {
  source: string;
  ageBucket: string;
  open: number;
  resolved: number;
  critical: number;
}

interface ExceptionSummary {
  from: string;
  to: string;
  totalOpen: number;
  totalResolved: number;
  totalCritical: number;
  bySource: ExceptionBucket[];
  recent: Array<{
    id: number;
    subjectRef: string;
    source: string;
    severity: string;
    status: string;
    detectedAt: string;
  }>;
}

const AGE_LABELS: Record<string, string> = {
  "0-24h": "Last 24 hours",
  "1-7d": "1–7 days",
  "8-30d": "8–30 days",
  "30d+": "Over 30 days",
};

export function SettlementExceptions() {
  const [summary, setSummary] = useState<ExceptionSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const getAuthToken = (): string | null => {
    if (typeof localStorage === "undefined") return null;
    return localStorage.getItem("auth_token") ?? null;
  };

  useEffect(() => {
    let cancelled = false;
    const to = new Date();
    const from = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    fetch(
      `/api/v1/analytics/exceptions?from=${from.toISOString()}&to=${to.toISOString()}`,
      authToken
        ? { headers: { Authorization: `Bearer ${authToken}` } }
        : undefined,
    )
      .then(async (r) => {
        if (!r.ok) throw new Error(`Exceptions request failed (${r.status})`);
        return r.json();
      })
      .then((data) => {
        if (!cancelled) setSummary(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [authToken]);

  if (loading) {
    return (
      <section className="rounded-3xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading exceptions…</p>
      </section>
    );
  }

  if (error) {
    return (
      <section className="rounded-3xl border border-red-200 bg-red-50 p-6 text-red-800 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200">
        <h2 className="text-sm font-semibold">Exceptions unavailable</h2>
        <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>
      </section>
    );
  }

  return (
    <section className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-zinc-500 dark:text-zinc-400">
            Settlement &amp; payout exceptions
          </h2>
          <p className="mt-1 text-sm text-zinc-900 dark:text-zinc-50">
            Aggregated by source and age. Drill down via
            <a
              href="/admin/discrepancies"
              className="text-indigo-600 hover:underline dark:text-indigo-400"
              rel="noopener noreferrer"
            >
              /admin/discrepancies
            </a>
            .
          </p>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
          <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
            Open exceptions
          </p>
          <p className="mt-2 text-2xl font-bold text-zinc-900 dark:text-zinc-50">
            {summary.totalOpen}
          </p>
        </div>
        <div className="rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
          <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
            Critical
          </p>
          <p className="mt-2 text-2xl font-bold text-red-600 dark:text-red-400">
            {summary.totalCritical}
          </p>
        </div>
        <div className="rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
          <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
            Resolved (30d)
          </p>
          <p className="mt-2 text-2xl font-bold text-zinc-900 dark:text-zinc-50">
            {summary.totalResolved}
          </p>
        </div>
      </div>

      <div className="rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-3">
          By source and age
        </h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-zinc-600 dark:text-zinc-300">
            <thead>
              <tr className="border-b border-zinc-200 dark:border-zinc-800">
                <th className="text-left pb-2 font-semibold text-zinc-900 dark:text-zinc-100">Source</th>
                <th className="text-left pb-2 font-semibold text-zinc-900 dark:text-zinc-100">Age bucket</th>
                <th className="text-right pb-2 font-semibold text-zinc-900 dark:text-zinc-100">Open</th>
                <th className="text-right pb-2 font-semibold text-zinc-900 dark:text-zinc-100">Resolved</th>
                <th className="text-right pb-2 font-semibold text-zinc-900 dark:text-zinc-100">Critical</th>
              </tr>
            </thead>
            <tbody>
              {summary.bySource.map((b) => (
                <tr
                  key={`${b.source}-${b.ageBucket}`}
                  className="border-b border-zinc-100 dark:border-zinc-900/50"
                >
                  <td className="py-2">{b.source}</td>
                  <td className="py-2">{AGE_LABELS[b.ageBucket] ?? b.ageBucket}</td>
                  <td className="text-right py-2">{b.open}</td>
                  <td className="text-right py-2">{b.resolved}</td>
                  <td className="text-right py-2">{b.critical}</td>
                </tr>
              ))}
              {summary.bySource.length === 0 && (
                <tr>
                  <td colSpan="5" className="py-4 text-center text-zinc-500 dark:text-zinc-400">
                    No exceptions in the selected window.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {summary.recent.length > 0 && (
        <div className="rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-3">
            Recent exceptions
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-zinc-600 dark:text-zinc-300">
              <thead>
                <tr className="border-b border-zinc-200 dark:border-zinc-800">
                  <th className="text-left pb-2 font-semibold text-zinc-900 dark:text-zinc-100">Subject</th>
                  <th className="text-left pb-2 font-semibold text-zinc-900 dark:text-zinc-100">Source</th>
                  <th className="text-left pb-2 font-semibold text-zinc-900 dark:text-zinc-100">Severity</th>
                  <th className="text-left pb-2 font-semibold text-zinc-900 dark:text-zinc-100">Status</th>
                  <th className="text-left pb-2 font-semibold text-zinc-900 dark:text-zinc-100">Detected</th>
                </tr>
              </thead>
              <tbody>
                {summary.recent.map((r) => (
                  <tr key={r.id} className="border-b border-zinc-100 dark:border-zinc-900/50">
                    <td className="py-2">{r.subjectRef}</td>
                    <td className="py-2">{r.source}</td>
                    <td className="py-2">{r.severity}</td>
                    <td className="py-2">{r.status}</td>
                    <td className="py-2 text-xs">{new Date(r.detectedAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
