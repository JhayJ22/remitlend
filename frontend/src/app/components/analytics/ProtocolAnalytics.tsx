"use client";

import { useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useProtocolStats, type ProtocolStats } from "../../hooks/useApi";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/Card";
import { Button } from "../ui/Button";

export const DATE_RANGES = [30, 90, 365] as const;
const COLORS = ["#4f46e5", "#16a34a", "#dc2626", "#d97706", "#0891b2", "#9333ea"];

const csvCell = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;

/** Flattens every chart's data into one CSV (section,label,value[,value2]). */
export function protocolStatsToCsv(stats: ProtocolStats): string {
  const rows: (string | number)[][] = [["section", "label", "value", "value2"]];
  for (const [k, v] of Object.entries(stats.loansByStatus)) rows.push(["loansByStatus", k, v, ""]);
  for (const p of stats.volumeByBucket)
    rows.push(["volumeByBucket", p.timestamp, p.totalOriginated, p.totalRepaid]);
  for (const [k, v] of Object.entries(stats.defaultRateByCorridor))
    rows.push(["defaultRateByCorridor", k, v, ""]);
  for (const b of stats.scoreDistribution) rows.push(["scoreDistribution", b.bucket, b.count, ""]);
  return rows.map((r) => r.map(csvCell).join(",")).join("\n");
}

function ChartCard({ title, label, children }: { title: string; label: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div role="img" aria-label={label}>
          <ResponsiveContainer width="100%" height={260}>
            {children as React.ReactElement}
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

export function ProtocolAnalytics() {
  const [days, setDays] = useState<number>(30);
  const { data, isLoading, isError, refetch } = useProtocolStats(days);

  function exportCsv() {
    if (!data) return;
    const blob = new Blob([protocolStatsToCsv(data)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `protocol-stats-${days}d.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="space-y-6" aria-label="Protocol analytics">
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Date range" className="flex gap-2">
          {DATE_RANGES.map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              aria-pressed={days === d}
              className={`px-4 py-1.5 rounded-full text-sm font-semibold ${
                days === d
                  ? "bg-indigo-600 text-white"
                  : "bg-zinc-100 text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
              }`}
            >
              Last {d} days
            </button>
          ))}
        </div>
        <Button onClick={exportCsv} disabled={!data} variant="outline">
          Export CSV
        </Button>
      </div>

      {isLoading && (
        <div role="status" aria-live="polite" className="text-sm text-zinc-500">
          Loading protocol analytics…
        </div>
      )}

      {isError && (
        <div role="alert" className="rounded-xl border border-red-300 p-4 text-sm text-red-700">
          Failed to load protocol analytics.{" "}
          <button className="underline" onClick={() => refetch()}>
            Retry
          </button>
        </div>
      )}

      {data && (
        <div className="grid gap-6 lg:grid-cols-2">
          <ChartCard title="Loans by status" label="Donut chart of total loans by status">
            <PieChart>
              <Pie
                data={Object.entries(data.loansByStatus).map(([name, value]) => ({ name, value }))}
                dataKey="value"
                nameKey="name"
                innerRadius={55}
                outerRadius={90}
              >
                {Object.keys(data.loansByStatus).map((_, i) => (
                  <Cell key={i} fill={COLORS[i % COLORS.length]} />
                ))}
              </Pie>
              <Tooltip />
              <Legend />
            </PieChart>
          </ChartCard>

          <ChartCard title="Loan volume over time" label="Line chart of loan volume originated and repaid over time">
            <LineChart
              data={data.volumeByBucket.map((p) => ({
                date: p.timestamp.slice(0, 10),
                originated: Number(p.totalOriginated),
                repaid: Number(p.totalRepaid),
              }))}
            >
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" />
              <YAxis />
              <Tooltip />
              <Legend />
              <Line type="monotone" dataKey="originated" stroke={COLORS[0]} />
              <Line type="monotone" dataKey="repaid" stroke={COLORS[1]} />
            </LineChart>
          </ChartCard>

          <ChartCard title="Default rate by corridor" label="Bar chart of default rate by corridor">
            <BarChart
              data={Object.entries(data.defaultRateByCorridor).map(([corridor, rate]) => ({
                corridor,
                rate: Math.round(rate * 1000) / 10,
              }))}
            >
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="corridor" />
              <YAxis unit="%" />
              <Tooltip />
              <Legend />
              <Bar dataKey="rate" name="Default rate (%)" fill={COLORS[2]} />
            </BarChart>
          </ChartCard>

          <ChartCard title="Score distribution" label="Histogram of borrower credit scores">
            <BarChart data={data.scoreDistribution}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="bucket" />
              <YAxis allowDecimals={false} />
              <Tooltip />
              <Legend />
              <Bar dataKey="count" name="Borrowers" fill={COLORS[0]} />
            </BarChart>
          </ChartCard>
        </div>
      )}
    </section>
  );
}
