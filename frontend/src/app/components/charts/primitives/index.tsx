"use client";

/**
 * Accessible, animation-aware chart primitives built on Recharts.
 *
 * Every chart here:
 *  - renders inside a labelled `<figure>` with a `<figcaption>`;
 *  - exposes the underlying data as a visually-hidden `<table>` so screen
 *    readers get the numbers, not just "chart";
 *  - enables Recharts' `accessibilityLayer` for keyboard navigation of points;
 *  - disables entry animations when the user has `prefers-reduced-motion: reduce`.
 *
 * Prefer these over hand-rolling Recharts in feature code.
 */

import { useMemo, type ReactNode } from "react";
import {
  Area,
  AreaChart as RcAreaChart,
  Bar,
  BarChart as RcBarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart as RcLineChart,
  Pie,
  PieChart as RcPieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useReducedMotion } from "framer-motion";
import { cn } from "@/app/utils/cn";
import { Skeleton } from "../../ui/Skeleton";

/** Brand-neutral categorical palette, reused across every chart. */
export const CHART_COLORS = [
  "#6366f1", // indigo
  "#10b981", // emerald
  "#f59e0b", // amber
  "#3b82f6", // blue
  "#ec4899", // pink
  "#8b5cf6", // violet
];

export interface ChartSeries {
  /** Key into each data row. */
  key: string;
  /** Human label shown in the legend, tooltip and SR table. */
  label: string;
  /** Overrides the palette colour for this series. */
  color?: string;
}

export interface BaseChartProps {
  data: Array<Record<string, string | number>>;
  /** Key used for the category / x-axis. */
  xKey: string;
  series: ChartSeries[];
  /** Required — becomes the figure's accessible name. */
  title: string;
  /** Optional longer description rendered in the caption. */
  description?: string;
  height?: number;
  loading?: boolean;
  className?: string;
  /** Formats numeric values in axes, tooltips and the SR table. */
  valueFormatter?: (value: number) => string;
}

const defaultFormatter = (value: number) => `${value}`;

/** Wraps a numeric formatter so it is safe to hand to Recharts' `formatter`. */
const toRechartsFormatter =
  (fn: (value: number) => string) =>
  (value: number | string): string =>
    fn(Number(value));

const listLabels = (series: ChartSeries[]) => series.map((s) => s.label).join(", ");

/** Builds the screen-reader summary sentence rendered after each chart. */
function srCaptionFor(
  kind: string,
  title: string,
  count: number,
  unit: string,
  series: ChartSeries[],
) {
  return `${title}: ${kind} with ${count} ${unit} across ${listLabels(series)}.`;
}

function seriesColor(s: ChartSeries, i: number) {
  return s.color ?? CHART_COLORS[i % CHART_COLORS.length];
}

/** Loading placeholder for any chart. Respects reduced motion via `Skeleton`. */
export function ChartSkeleton({
  height = 300,
  className,
}: {
  height?: number;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-label="Loading chart"
      className={cn(
        "rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950",
        className,
      )}
    >
      <Skeleton className="mb-4 h-5 w-40" />
      <Skeleton className="w-full rounded-lg" style={{ height }} />
      <div className="mt-4 flex gap-3">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-3 w-16" />
      </div>
    </div>
  );
}

/** Screen-reader-only tabular representation of the chart data. */
function DataTable({
  data,
  xKey,
  series,
  caption,
  valueFormatter,
}: Pick<BaseChartProps, "data" | "xKey" | "series"> & {
  caption: string;
  valueFormatter: (value: number) => string;
}) {
  return (
    <table className="sr-only">
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">{xKey}</th>
          {series.map((s) => (
            <th key={s.key} scope="col">
              {s.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {data.map((row, i) => (
          <tr key={i}>
            <th scope="row">{String(row[xKey])}</th>
            {series.map((s) => (
              <td key={s.key}>
                {typeof row[s.key] === "number"
                  ? valueFormatter(row[s.key] as number)
                  : String(row[s.key] ?? "")}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface ChartFigureProps extends Pick<BaseChartProps, "title" | "description" | "className"> {
  srCaption: string;
  table: ReactNode;
  children: ReactNode;
}

function ChartFigure({
  title,
  description,
  className,
  srCaption,
  table,
  children,
}: ChartFigureProps) {
  return (
    <figure
      className={cn("m-0", className)}
      role="group"
      aria-label={description ? `${title}. ${description}` : title}
    >
      <figcaption className="mb-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">
        {title}
        {description && (
          <span className="block text-xs font-normal text-zinc-500 dark:text-zinc-400">
            {description}
          </span>
        )}
      </figcaption>
      {table}
      <div aria-hidden="true">{children}</div>
      <p className="sr-only">{srCaption}</p>
    </figure>
  );
}

const axisProps = {
  tick: { fill: "currentColor", fontSize: 12 },
  tickLine: { stroke: "currentColor" },
  className: "text-zinc-500 dark:text-zinc-400",
} as const;

const tooltipProps = {
  contentStyle: {
    borderRadius: 12,
    border: "1px solid var(--tw-prose-hr, #e4e4e7)",
    background: "rgba(255,255,255,0.98)",
    fontSize: 12,
  },
  wrapperClassName: "dark:[&_.recharts-tooltip-item]:!text-zinc-200",
} as const;

function useAnimation() {
  const reduced = useReducedMotion();
  return { isAnimationActive: !reduced, animationDuration: reduced ? 0 : 600 };
}

/* ─────────────────────────────  Line  ────────────────────────────── */

export function LineChart(props: BaseChartProps) {
  const { data, xKey, series, height = 300, loading, valueFormatter = defaultFormatter } = props;
  const anim = useAnimation();
  const srCaption = useMemo(
    () => srCaptionFor("line chart", props.title, data.length, "points", series),
    [props.title, data.length, series],
  );

  if (loading) return <ChartSkeleton height={height} className={props.className} />;

  return (
    <ChartFigure
      {...props}
      srCaption={srCaption}
      table={
        <DataTable
          data={data}
          xKey={xKey}
          series={series}
          caption={props.title}
          valueFormatter={valueFormatter}
        />
      }
    >
      <ResponsiveContainer width="100%" height={height}>
        <RcLineChart
          data={data}
          margin={{ top: 5, right: 16, left: 0, bottom: 5 }}
          accessibilityLayer
        >
          <CartesianGrid strokeDasharray="3 3" className="stroke-zinc-200 dark:stroke-zinc-800" />
          <XAxis dataKey={xKey} {...axisProps} />
          <YAxis {...axisProps} tickFormatter={valueFormatter} />
          <Tooltip {...tooltipProps} formatter={toRechartsFormatter(valueFormatter)} />
          <Legend />
          {series.map((s, i) => (
            <Line
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.label}
              stroke={seriesColor(s, i)}
              strokeWidth={2}
              dot={false}
              {...anim}
            />
          ))}
        </RcLineChart>
      </ResponsiveContainer>
    </ChartFigure>
  );
}

/* ─────────────────────────────  Area  ────────────────────────────── */

export function AreaChart(props: BaseChartProps) {
  const { data, xKey, series, height = 300, loading, valueFormatter = defaultFormatter } = props;
  const anim = useAnimation();
  const srCaption = srCaptionFor("area chart", props.title, data.length, "points", series);

  if (loading) return <ChartSkeleton height={height} className={props.className} />;

  return (
    <ChartFigure
      {...props}
      srCaption={srCaption}
      table={
        <DataTable
          data={data}
          xKey={xKey}
          series={series}
          caption={props.title}
          valueFormatter={valueFormatter}
        />
      }
    >
      <ResponsiveContainer width="100%" height={height}>
        <RcAreaChart
          data={data}
          margin={{ top: 5, right: 16, left: 0, bottom: 5 }}
          accessibilityLayer
        >
          <defs>
            {series.map((s, i) => (
              <linearGradient key={s.key} id={`grad-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={seriesColor(s, i)} stopOpacity={0.7} />
                <stop offset="95%" stopColor={seriesColor(s, i)} stopOpacity={0.05} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid strokeDasharray="3 3" className="stroke-zinc-200 dark:stroke-zinc-800" />
          <XAxis dataKey={xKey} {...axisProps} />
          <YAxis {...axisProps} tickFormatter={valueFormatter} />
          <Tooltip {...tooltipProps} formatter={toRechartsFormatter(valueFormatter)} />
          <Legend />
          {series.map((s, i) => (
            <Area
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.label}
              stroke={seriesColor(s, i)}
              strokeWidth={2}
              fill={`url(#grad-${s.key})`}
              {...anim}
            />
          ))}
        </RcAreaChart>
      </ResponsiveContainer>
    </ChartFigure>
  );
}

/* ─────────────────────────────  Bar  ─────────────────────────────── */

export function BarChart(props: BaseChartProps & { stacked?: boolean }) {
  const {
    data,
    xKey,
    series,
    height = 300,
    loading,
    stacked,
    valueFormatter = defaultFormatter,
  } = props;
  const anim = useAnimation();
  const srCaption = srCaptionFor("bar chart", props.title, data.length, "categories", series);

  if (loading) return <ChartSkeleton height={height} className={props.className} />;

  return (
    <ChartFigure
      {...props}
      srCaption={srCaption}
      table={
        <DataTable
          data={data}
          xKey={xKey}
          series={series}
          caption={props.title}
          valueFormatter={valueFormatter}
        />
      }
    >
      <ResponsiveContainer width="100%" height={height}>
        <RcBarChart
          data={data}
          margin={{ top: 5, right: 16, left: 0, bottom: 5 }}
          accessibilityLayer
        >
          <CartesianGrid strokeDasharray="3 3" className="stroke-zinc-200 dark:stroke-zinc-800" />
          <XAxis dataKey={xKey} {...axisProps} />
          <YAxis {...axisProps} tickFormatter={valueFormatter} />
          <Tooltip
            {...tooltipProps}
            formatter={toRechartsFormatter(valueFormatter)}
            cursor={{ opacity: 0.1 }}
          />
          <Legend />
          {series.map((s, i) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              name={s.label}
              fill={seriesColor(s, i)}
              radius={[4, 4, 0, 0]}
              stackId={stacked ? "stack" : undefined}
              {...anim}
            />
          ))}
        </RcBarChart>
      </ResponsiveContainer>
    </ChartFigure>
  );
}

/* ─────────────────────────────  Pie  ─────────────────────────────── */

export interface PieChartProps
  extends Pick<
    BaseChartProps,
    "title" | "description" | "height" | "loading" | "className" | "valueFormatter"
  > {
  data: Array<{ name: string; value: number; color?: string }>;
}

export function PieChart({
  data,
  title,
  description,
  height = 300,
  loading,
  className,
  valueFormatter = defaultFormatter,
}: PieChartProps) {
  const anim = useAnimation();
  const total = data.reduce((sum, d) => sum + d.value, 0);
  const pct = (v: number) => (total ? Math.round((v / total) * 100) : 0);
  const slices = data.map((d) => `${d.name} ${pct(d.value)}%`).join(", ");
  const srCaption = `Pie chart "${title}" with ${data.length} slices: ${slices}.`;

  if (loading) return <ChartSkeleton height={height} className={className} />;

  return (
    <ChartFigure
      title={title}
      description={description}
      className={className}
      srCaption={srCaption}
      table={
        <table className="sr-only">
          <caption>{title}</caption>
          <thead>
            <tr>
              <th scope="col">Segment</th>
              <th scope="col">Value</th>
            </tr>
          </thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.name}>
                <th scope="row">{d.name}</th>
                <td>{valueFormatter(d.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      }
    >
      <ResponsiveContainer width="100%" height={height}>
        <RcPieChart accessibilityLayer>
          <Tooltip {...tooltipProps} formatter={toRechartsFormatter(valueFormatter)} />
          <Legend />
          <Pie
            data={data}
            dataKey="value"
            nameKey="name"
            cx="50%"
            cy="50%"
            outerRadius="80%"
            {...anim}
          >
            {data.map((d, i) => (
              <Cell key={d.name} fill={d.color ?? CHART_COLORS[i % CHART_COLORS.length]} />
            ))}
          </Pie>
        </RcPieChart>
      </ResponsiveContainer>
    </ChartFigure>
  );
}
