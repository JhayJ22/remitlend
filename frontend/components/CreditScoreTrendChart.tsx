import React, { useEffect, useMemo, useState } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
  Legend,
} from 'recharts';

export interface ScoreFactor {
  factor: string;
  contribution: number;
}

export interface ScoreHistoryPoint {
  month: string;
  score: number;
}

export interface CreditScoreResponse {
  userId: string;
  score: number;
  history?: ScoreHistoryPoint[];
  breakdown?: ScoreFactor[];
}

export type ScoreTier = 'Poor' | 'Fair' | 'Good' | 'Excellent';

const TIER_COLORS: Record<ScoreTier, string> = {
  Poor: '#b91c1c',
  Fair: '#b45309',
  Good: '#15803d',
  Excellent: '#1d4ed8',
};

export function getScoreTier(score: number): ScoreTier {
  if (score < 580) return 'Poor';
  if (score < 670) return 'Fair';
  if (score < 740) return 'Good';
  return 'Excellent';
}

interface ScoreDialProps {
  score: number;
  tier: ScoreTier;
}

function ScoreDial({ score, tier }: ScoreDialProps) {
  const clamped = Math.max(0, Math.min(850, score));
  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  const progress = (clamped / 850) * circumference;

  return (
    <svg
      width={140}
      height={140}
      viewBox="0 0 140 140"
      role="img"
      aria-label={`Credit score ${clamped} out of 850, tier ${tier}`}
    >
      <circle
        cx={70}
        cy={70}
        r={radius}
        fill="none"
        stroke="#e5e7eb"
        strokeWidth={12}
      />
      <circle
        cx={70}
        cy={70}
        r={radius}
        fill="none"
        stroke={TIER_COLORS[tier]}
        strokeWidth={12}
        strokeLinecap="round"
        strokeDasharray={`${progress} ${circumference}`}
        transform="rotate(-90 70 70)"
      />
      <text
        x={70}
        y={66}
        textAnchor="middle"
        fontSize={28}
        fontWeight={700}
        fill="#111827"
      >
        {clamped}
      </text>
      <text
        x={70}
        y={88}
        textAnchor="middle"
        fontSize={13}
        fill={TIER_COLORS[tier]}
      >
        {tier}
      </text>
    </svg>
  );
}

interface CreditScoreTrendChartProps {
  userId: string;
  apiBaseUrl?: string;
}

export default function CreditScoreTrendChart({
  userId,
  apiBaseUrl = '',
}: CreditScoreTrendChartProps) {
  const [data, setData] = useState<CreditScoreResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch(`${apiBaseUrl}/scores/${encodeURIComponent(userId)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to load score (${res.status})`);
        return res.json() as Promise<CreditScoreResponse>;
      })
      .then((json) => {
        if (!cancelled) setData(json);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [userId, apiBaseUrl]);

  const history = useMemo(() => {
    const points = data?.history ?? [];
    return points.slice(-12);
  }, [data]);

  const breakdown = data?.breakdown ?? [];
  const tier = data ? getScoreTier(data.score) : 'Poor';

  if (loading) {
    return <div role="status">Loading credit score…</div>;
  }

  if (error) {
    return <div role="alert">Unable to load credit score: {error}</div>;
  }

  if (!data) {
    return <div role="status">No credit score available.</div>;
  }

  return (
    <section aria-label="Credit score overview">
      <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
        <ScoreDial score={data.score} tier={tier} />
        <div>
          <h2 style={{ margin: 0 }}>Credit Score</h2>
          <p style={{ margin: '4px 0', color: TIER_COLORS[tier] }}>
            Tier: {tier}
          </p>
        </div>
      </div>

      <div style={{ marginTop: 24 }}>
        <h3>Score Trend (last 12 months)</h3>
        {history.length === 0 ? (
          <p>No score history yet.</p>
        ) : (
          <div style={{ width: '100%', height: 260 }}>
            <ResponsiveContainer>
              <LineChart data={history}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="month" />
                <YAxis domain={[300, 850]} />
                <Tooltip />
                <Line
                  type="monotone"
                  dataKey="score"
                  stroke={TIER_COLORS[tier]}
                  strokeWidth={2}
                  dot={{ r: 3 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      <div style={{ marginTop: 24 }}>
        <h3>Score Factors</h3>
        {breakdown.length === 0 ? (
          <p>No factor breakdown available.</p>
        ) : (
          <div style={{ width: '100%', height: 260 }}>
            <ResponsiveContainer>
              <BarChart data={breakdown} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis type="number" />
                <YAxis type="category" dataKey="factor" width={140} />
                <Tooltip />
                <Legend />
                <Bar dataKey="contribution" name="Contribution" fill={TIER_COLORS[tier]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </section>
  );
}
