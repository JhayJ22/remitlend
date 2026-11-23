/**
 * Capacity snapshots table for load-test validation (issue #865).
 *
 * Stores point-in-time capacity model snapshots so operators and load-test
 * harnesses can compare the model's forecasts against measured observations.
 *
 * Columns
 * ───────
 * captured_at                    — ISO-8601 timestamp (unique; deduplicates
 *                                  repeated minute-level snapshots)
 * forecast_days                  — Forecast horizon used for this snapshot
 * total_db_estimated_bytes       — Sum of all table estimated sizes (bytes)
 * total_db_projected_bytes       — Sum of all projected sizes after forecast_days
 * connection_peak                — Peak concurrent DB connections (demand model)
 * connection_utilization_ratio   — peak / POSTGRES_MAX_CONNECTIONS (0–1)
 * redis_total_bytes_estimate     — Estimated Redis memory demand (bytes)
 * overall_threshold_level        — 'ok' | 'warn' | 'critical'
 * snapshot_json                  — Full CapacitySnapshot JSON for detailed review
 *
 * Retention
 * ─────────
 * Snapshots are lightweight (< 10 KB each) and taken hourly by default.
 * Rows older than CAPACITY_SNAPSHOT_RETENTION_DAYS (default 90 days) may
 * be pruned by an operator or automated job without affecting the model's
 * correctness — the table is advisory only.
 *
 * Compatibility
 * ─────────────
 * Additive schema change: no existing table is modified.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {void}
 */
export const up = (pgm) => {
  pgm.createTable('capacity_snapshots', {
    id: { type: 'bigserial', primaryKey: true },

    captured_at: {
      type: 'timestamp with time zone',
      notNull: true,
    },

    forecast_days: {
      type: 'integer',
      notNull: true,
      default: 30,
    },

    total_db_estimated_bytes: {
      type: 'bigint',
      notNull: true,
      default: 0,
    },

    total_db_projected_bytes: {
      type: 'bigint',
      notNull: true,
      default: 0,
    },

    connection_peak: {
      type: 'integer',
      notNull: true,
      default: 0,
    },

    connection_utilization_ratio: {
      type: 'numeric(6,4)',
      notNull: true,
      default: 0,
    },

    redis_total_bytes_estimate: {
      type: 'bigint',
      notNull: true,
      default: 0,
    },

    overall_threshold_level: {
      type: 'varchar(10)',
      notNull: true,
      default: 'ok',
    },

    snapshot_json: {
      type: 'jsonb',
      notNull: true,
      default: '{}',
    },

    created_at: {
      type: 'timestamp with time zone',
      notNull: true,
      default: pgm.func('NOW()'),
    },
  });

  // Unique constraint so ON CONFLICT (captured_at) DO NOTHING works in upserts.
  pgm.addConstraint(
    'capacity_snapshots',
    'capacity_snapshots_captured_at_unique',
    { unique: ['captured_at'] },
  );

  // Index for time-range queries and for the retention purge job.
  pgm.createIndex('capacity_snapshots', 'captured_at', {
    name: 'capacity_snapshots_captured_at_index',
  });

  // Index for filtering by threshold level (operator alert queries).
  pgm.createIndex('capacity_snapshots', 'overall_threshold_level', {
    name: 'capacity_snapshots_threshold_level_index',
  });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {void}
 */
export const down = (pgm) => {
  pgm.dropTable('capacity_snapshots');
};
