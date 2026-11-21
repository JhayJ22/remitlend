import { query } from '../db/connection.js';

const RECOVERY_BASE =
  'https://github.com/JhayJ22/remitlend/blob/main/docs/runbooks/settlement-payout-exceptions.md';
const EXCEPTION_CTES = `
  WITH raw_exceptions AS (
    SELECT
      'delayed'::text AS exception_type,
      source_type::text AS source,
      status::text AS status,
      'remittance:' || id::text AS subject_ref,
      created_at AS detected_at,
      $1::text AS recovery_procedure
    FROM remittances
    WHERE status IN ('pending', 'processing')
      AND created_at <= NOW() - INTERVAL '1 hour'

    UNION ALL

    SELECT
      'unresolved'::text,
      source_type::text,
      status::text,
      'remittance:' || id::text,
      created_at,
      $2::text
    FROM remittances
    WHERE status = 'failed'

    UNION ALL

    SELECT
      'duplicate'::text,
      source_type::text,
      status::text,
      'remittance:' || id::text,
      created_at,
      $3::text
    FROM (
      SELECT remittances.*,
        COUNT(*) OVER (PARTITION BY transaction_hash) AS matching_transactions
      FROM remittances
      WHERE transaction_hash IS NOT NULL
    ) duplicate_remittances
    WHERE matching_transactions > 1

    UNION ALL

    SELECT
      'mismatched'::text,
      discrepancy_class::text,
      status::text,
      'discrepancy:' || id::text,
      detected_at,
      $4::text
    FROM reconciliation_discrepancies
    WHERE status = 'open'

    UNION ALL

    SELECT
      'unresolved'::text,
      operation::text,
      state::text,
      'cross-contract:' || id::text,
      created_at,
      $5::text
    FROM cross_contract_reconciliation
    WHERE state IN ('pending', 'half_applied', 'failed')
  ),
  exceptions AS (
    SELECT
      exception_type, source, status, subject_ref, detected_at, recovery_procedure,
      CASE
        WHEN detected_at > NOW() - INTERVAL '1 hour' THEN 'under_1h'
        WHEN detected_at > NOW() - INTERVAL '1 day' THEN '1h_24h'
        WHEN detected_at > NOW() - INTERVAL '7 days' THEN '1d_7d'
        ELSE 'over_7d'
      END AS age_bucket
    FROM raw_exceptions
  )
`;

const recoveryProcedures = [
  `${RECOVERY_BASE}#delayed-or-failed-remittances`,
  `${RECOVERY_BASE}#delayed-or-failed-remittances`,
  `${RECOVERY_BASE}#duplicate-payouts`,
  `${RECOVERY_BASE}#mismatched-settlement-records`,
  `${RECOVERY_BASE}#unresolved-cross-contract-settlements`,
];

export interface SettlementExceptionSummary {
  exceptionType: string;
  source: string;
  ageBucket: string;
  count: number;
}

export interface SettlementException {
  exceptionType: string;
  source: string;
  status: string;
  subjectRef: string;
  detectedAt: string;
  ageBucket: string;
  recoveryProcedure: string;
}

export async function getSettlementExceptions(): Promise<{
  summary: SettlementExceptionSummary[];
  exceptions: SettlementException[];
}> {
  const [summaryResult, detailsResult] = await Promise.all([
    query(
      `${EXCEPTION_CTES}
       SELECT exception_type, source, age_bucket, COUNT(*) AS count
       FROM exceptions
       GROUP BY exception_type, source, age_bucket
       ORDER BY exception_type, source, age_bucket`,
      recoveryProcedures,
    ),
    query(
      `${EXCEPTION_CTES}
       SELECT exception_type, source, status, subject_ref, detected_at, age_bucket,
              recovery_procedure
       FROM exceptions
       ORDER BY detected_at DESC, subject_ref
       LIMIT 200`,
      recoveryProcedures,
    ),
  ]);

  return {
    summary: summaryResult.rows.map((row) => ({
      exceptionType: row.exception_type,
      source: row.source,
      ageBucket: row.age_bucket,
      count: Number(row.count),
    })),
    exceptions: detailsResult.rows.map((row) => ({
      exceptionType: row.exception_type,
      source: row.source,
      status: row.status,
      subjectRef: row.subject_ref,
      detectedAt: new Date(row.detected_at).toISOString(),
      ageBucket: row.age_bucket,
      recoveryProcedure: row.recovery_procedure,
    })),
  };
}
