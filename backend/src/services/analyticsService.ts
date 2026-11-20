import { query } from '../db/connection.js';

export const ANALYTICS_BUCKETS = ['day', 'week', 'month'] as const;
export type AnalyticsBucket = (typeof ANALYTICS_BUCKETS)[number];

export const SCORE_BUCKETS = [
  { label: '300-499', min: 300, max: 499 },
  { label: '500-649', min: 500, max: 649 },
  { label: '650-799', min: 650, max: 799 },
  { label: '800-850', min: 800, max: 850 },
] as const;

export interface ProtocolStats {
  from: string;
  to: string;
  bucket: AnalyticsBucket;
  loansByStatus: Record<string, number>;
  volumeByBucket: { timestamp: string; totalOriginated: string; totalRepaid: string }[];
  defaultRateByCorridor: Record<string, number>;
  scoreDistribution: { bucket: string; count: number }[];
}

/**
 * Indexed aggregations over loan_history (created_at/status indexes) and
 * scores. Money sums stay as numeric strings to avoid float drift.
 */
export async function computeProtocolStats(
  from: Date,
  to: Date,
  bucket: AnalyticsBucket,
): Promise<ProtocolStats> {
  if (!ANALYTICS_BUCKETS.includes(bucket)) {
    throw new Error(`Invalid bucket: ${bucket}`);
  }
  const range: [string, string] = [from.toISOString(), to.toISOString()];

  const [statusRes, volumeRes, corridorRes, scoreRes] = await Promise.all([
    query(
      `SELECT status, COUNT(*)::int AS count FROM loan_history
        WHERE created_at >= $1 AND created_at <= $2 GROUP BY status`,
      range,
    ),
    query(
      `SELECT date_trunc('${bucket}', created_at) AS ts,
              COALESCE(SUM(principal_amount), 0)::text AS total_originated,
              COALESCE(SUM(COALESCE(principal_paid, 0)), 0)::text AS total_repaid
         FROM loan_history
        WHERE created_at >= $1 AND created_at <= $2
        GROUP BY ts ORDER BY ts ASC`,
      range,
    ),
    query(
      `SELECT COALESCE(r.corridor, 'UNKNOWN') AS corridor,
              ROUND(COUNT(*) FILTER (WHERE l.status = 'defaulted')::numeric / COUNT(*), 4)::float AS rate
         FROM loan_history l
         LEFT JOIN LATERAL (
           SELECT from_currency || '-' || to_currency AS corridor
             FROM remittances WHERE sender_id = l.borrower_public_key
            ORDER BY created_at DESC LIMIT 1
         ) r ON TRUE
        WHERE l.created_at >= $1 AND l.created_at <= $2
        GROUP BY 1`,
      range,
    ),
    query(
      `SELECT CASE WHEN score < 500 THEN 0 WHEN score < 650 THEN 1 WHEN score < 800 THEN 2 ELSE 3 END AS b,
              COUNT(*)::int AS count
         FROM scores GROUP BY 1`,
    ),
  ]);

  const loansByStatus: Record<string, number> = {};
  for (const r of statusRes.rows) loansByStatus[String(r.status)] = Number(r.count);

  const defaultRateByCorridor: Record<string, number> = {};
  for (const r of corridorRes.rows) defaultRateByCorridor[String(r.corridor)] = Number(r.rate);

  const counts = new Map<number, number>(scoreRes.rows.map((r) => [Number(r.b), Number(r.count)]));

  return {
    from: range[0],
    to: range[1],
    bucket,
    loansByStatus,
    volumeByBucket: volumeRes.rows.map((r) => ({
      timestamp: new Date(r.ts).toISOString(),
      totalOriginated: String(r.total_originated),
      totalRepaid: String(r.total_repaid),
    })),
    defaultRateByCorridor,
    scoreDistribution: SCORE_BUCKETS.map((b, i) => ({ bucket: b.label, count: counts.get(i) ?? 0 })),
  };
}
