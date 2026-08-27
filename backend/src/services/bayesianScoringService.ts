import { query } from '../db/connection.js';
import { cacheService } from './cacheService.js';
import logger from '../utils/logger.js';

export interface TieredScore {
  score: number;
  confidence: number;
  tier: 'initial' | 'developing' | 'established';
  mean: number;
  stdDev: number;
  transactionCount: number;
  credibleInterval: [number, number];
}

const PRIOR_MEAN = 500;
const PRIOR_STDDEV = 100;
const BASE_SCORE = 500;

function calculateBayesianUpdatedScore(
  priorMean: number,
  priorVariance: number,
  observedScores: number[],
  observedVariance: number,
): { mean: number; variance: number } {
  if (observedScores.length === 0) {
    return { mean: priorMean, variance: priorVariance };
  }

  const observedMean = observedScores.reduce((a, b) => a + b, 0) / observedScores.length;
  const n = observedScores.length;

  const posteriorVariance = 1 / (1 / priorVariance + n / observedVariance);
  const posteriorMean =
    posteriorVariance * (priorMean / priorVariance + (n * observedMean) / observedVariance);

  return { mean: posteriorMean, variance: posteriorVariance };
}

function calculateConfidence(variance: number, stdDevTarget: number = 50): number {
  const stdDev = Math.sqrt(variance);
  const confidence = Math.max(0, Math.min(1, 1 - stdDev / (stdDevTarget * 3)));
  return confidence;
}

function calculateCredibleInterval(mean: number, variance: number, z: number = 1.96): [number, number] {
  const stdDev = Math.sqrt(variance);
  const margin = z * stdDev;
  return [
    Math.max(300, Math.round(mean - margin)),
    Math.min(850, Math.round(mean + margin)),
  ];
}

export async function calculateTieredScore(userId: string): Promise<TieredScore> {
  const cacheKey = `tiered-score:${userId}`;
  const cached = await cacheService.get<TieredScore>(cacheKey);
  if (cached) {
    return cached;
  }

  const result = await query(
    `
    SELECT
      COUNT(ce.loan_id) as transaction_count,
      COALESCE(s.current_score, 500) as current_score
    FROM contract_events ce
    LEFT JOIN scores s ON ce.address = s.user_id
    WHERE ce.address = $1 AND ce.event_type IN ('LoanRepaid', 'LoanDefaulted')
    GROUP BY ce.address, s.current_score
  `,
    [userId],
  );

  const row = result.rows[0] || {
    transaction_count: 0,
    current_score: BASE_SCORE,
  };

  const transactionCount = parseInt(row.transaction_count, 10) || 0;
  const currentScore = row.current_score || BASE_SCORE;

  const priorVariance = PRIOR_STDDEV ** 2;
  const observedVariance = 50 ** 2;

  let updatedStats: { mean: number; variance: number };
  let tier: 'initial' | 'developing' | 'established';

  if (transactionCount === 0) {
    updatedStats = { mean: BASE_SCORE, variance: priorVariance };
    tier = 'initial';
  } else if (transactionCount < 5) {
    const observedScores = Array(Math.max(1, transactionCount)).fill(currentScore);
    updatedStats = calculateBayesianUpdatedScore(
      PRIOR_MEAN,
      priorVariance,
      observedScores,
      observedVariance,
    );
    tier = 'developing';
  } else {
    const observedScores = Array(transactionCount).fill(currentScore);
    updatedStats = calculateBayesianUpdatedScore(
      PRIOR_MEAN,
      priorVariance,
      observedScores,
      observedVariance,
    );
    tier = 'established';
  }

  const confidence = calculateConfidence(updatedStats.variance);
  const credibleInterval = calculateCredibleInterval(updatedStats.mean, updatedStats.variance);

  const tieredScore: TieredScore = {
    score: Math.round(updatedStats.mean),
    confidence: Math.round(confidence * 100) / 100,
    tier,
    mean: Math.round(updatedStats.mean * 100) / 100,
    stdDev: Math.round(Math.sqrt(updatedStats.variance) * 100) / 100,
    transactionCount,
    credibleInterval,
  };

  await cacheService.set(cacheKey, tieredScore, 600);

  return tieredScore;
}

export async function getScoreWithConfidence(userId: string): Promise<{
  score: number;
  confidence: number;
  tier: string;
  credibleInterval: [number, number];
}> {
  const tieredScore = await calculateTieredScore(userId);

  return {
    score: tieredScore.score,
    confidence: tieredScore.confidence,
    tier: tieredScore.tier,
    credibleInterval: tieredScore.credibleInterval,
  };
}

export async function filterLendersByConfidence(
  minConfidence: number = 0.6,
  lenderIds?: string[],
): Promise<
  Array<{
    lenderId: string;
    avgConfidence: number;
    borrowerCount: number;
  }>
> {
  let sql = `
    SELECT
      l.lender_id,
      AVG(bs.confidence) as avg_confidence,
      COUNT(DISTINCT loans.borrower) as borrower_count
    FROM loans
    JOIN users l ON loans.lender_id = l.user_id
    JOIN LATERAL (
      SELECT calculate_tiered_score(loans.borrower)->>'confidence' as confidence
    ) bs ON TRUE
    WHERE bs.confidence >= $1
  `;

  const params: (string | number)[] = [minConfidence];

  if (lenderIds && lenderIds.length > 0) {
    sql += ` AND loans.lender_id = ANY($2)`;
    params.push(lenderIds);
  }

  sql += ` GROUP BY l.lender_id ORDER BY avg_confidence DESC`;

  try {
    const result = await query(sql, params);
    return result.rows.map((row) => ({
      lenderId: row.lender_id,
      avgConfidence: parseFloat(row.avg_confidence),
      borrowerCount: parseInt(row.borrower_count, 10),
    }));
  } catch (error) {
    logger.error('Failed to filter lenders by confidence', { error });
    return [];
  }
}
