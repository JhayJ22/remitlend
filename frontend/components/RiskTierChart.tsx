'use client';

import React, { useMemo } from 'react';
import {
  Radar,
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  ResponsiveContainer,
  Tooltip,
} from 'recharts';

export interface ScoreFactor {
  factor: string;
  contribution: number;
  weight?: number;
}

export interface RiskTierChartProps {
  factors: ScoreFactor[];
  title?: string;
  height?: number;
}

const DEFAULT_TITLE = 'Score factor breakdown';

/**
 * Renders the per-factor contributions of a borrower's credit score as an
 * accessible radar chart. Each factor is normalized to a 0-100 axis so that
 * contributions of different magnitudes remain comparable.
 */
export default function RiskTierChart({
  factors,
  title = DEFAULT_TITLE,
  height = 320,
}: RiskTierChartProps) {
  const data = useMemo(() => {
    if (!factors || factors.length === 0) return [];
    const max = Math.max(...factors.map((f) => Math.abs(f.contribution)), 1);
    return factors.map((f) => ({
      factor: f.factor,
      contribution: f.contribution,
      normalized: Math.round((Math.abs(f.contribution) / max) * 100),
    }));
  }, [factors]);

  if (data.length === 0) {
    return (
      <div
        role="img"
        aria-label="Score factor breakdown unavailable: no factor data"
        className="flex items-center justify-center rounded-lg border border-dashed border-gray-300 p-6 text-sm text-gray-500"
        style={{ height }}
      >
        No factor breakdown available yet.
      </div>
    );
  }

  const summary = data
    .map((d) => `${d.factor}: ${d.contribution}`)
    .join(', ');

  return (
    <figure className="w-full" style={{ height }}>
      <figcaption className="mb-2 text-sm font-medium text-gray-700">
        {title}
      </figcaption>
      <div
        role="img"
        aria-label={`${title}. ${summary}`}
        className="h-full w-full"
      >
        <ResponsiveContainer width="100%" height="100%">
          <RadarChart data={data} outerRadius="75%">
            <PolarGrid />
            <PolarAngleAxis dataKey="factor" tick={{ fontSize: 12 }} />
            <PolarRadiusAxis angle={90} domain={[0, 100]} tick={false} />
            <Radar
              name="Contribution"
              dataKey="normalized"
              stroke="#2563eb"
              fill="#2563eb"
              fillOpacity={0.4}
            />
            <Tooltip
              formatter={(_value, _name, props) => {
                const payload = props?.payload as
                  | { contribution?: number }
                  | undefined;
                return [payload?.contribution ?? 0, 'Contribution'];
              }}
            />
          </RadarChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}
