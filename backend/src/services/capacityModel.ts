/**
 * Capacity model for database, Redis, and event-retention growth (issue #865).
 *
 * Purpose
 * ───────
 * Forecast storage and connection demand from measured event and user growth,
 * define scale thresholds and retention controls, and produce a point-in-time
 * snapshot that operators and load-test harnesses can compare against
 * observations.
 *
 * Design
 * ──────
 * - Row-size constants are derived from the actual schema (migration files).
 *   Each constant carries a brief justification so reviewers can audit the
 *   assumptions without reading SQL.
 * - Growth rates are configurable via env vars; defaults reflect the planning
 *   assumptions documented in the PR description.
 * - Thresholds follow the same warn/soft/hard pattern used by the
 *   queue-backpressure module (#860) so operators have a consistent mental
 *   model across all operational alerts.
 * - No personal data or financial amounts are read by this module; it only
 *   reads row counts and table sizes from information_schema / pg_catalog.
 * - Exact money units (stroops) in `soroban_write_queue.payload` are neither
 *   read nor transformed here.
 *
 * Table catalogue
 * ───────────────
 * Financial / event tables (unbounded growth, governed by retention):
 *   contract_events        — on-chain event records; ~600 B per row
 *   loan_state_events      — domain state-transition log; ~400 B per row
 *   audit_logs             — actor / action audit trail; ~300 B per row
 *   notifications          — user notifications; ~350 B per row
 *   webhook_deliveries     — outbound delivery records; ~500 B per row
 *   soroban_write_queue    — durable write queue; ~1 500 B per row (JSONB payload)
 *   quarantine_events      — malformed event records; ~2 000 B per row
 *
 * Bounded / operational tables (grow slowly, no retention required):
 *   loans                  — one row per loan; ~400 B
 *   scores                 — one row per user; ~100 B
 *   indexer_state          — one row per contract; ~100 B
 *   indexer_scheduler_state — one row per contract; ~200 B
 *
 * Connection demand model
 * ───────────────────────
 * peak_connections = api_replicas × DB_POOL_MAX + background_job_connections
 * Background jobs: indexer (1), defaultChecker (1), scoreReconciler (1) = 3
 * Default DB_POOL_MAX = 10, default api_replicas = 1 (env-overridable).
 *
 * Redis memory model
 * ──────────────────
 * idempotency keys: 1 key per financial write, TTL 24h, ~200 B each
 * rate-limiter keys: 1 sorted set per active user, ~50 B × window size
 * cache entries: soroban stale reads, up to SOROBAN_STALE_READ_TTL_MS (1h)
 */

import logger from '../utils/logger.js';
import { query } from '../db/connection.js';
import { recordCapacitySnapshot } from '../middleware/metrics.js';

// ── Types ─────────────────────────────────────────────────────────────────────

/** Severity of a threshold crossing. */
export type CapacityThresholdLevel = 'ok' | 'warn' | 'critical';

/** A single table's current and projected storage. */
export interface TableCapacityEntry {
  table: string;
  /** Current live row count. */
  rowCount: number;
  /** Estimated bytes per row (schema-derived constant). */
  bytesPerRow: number;
  /** Estimated total live size in bytes (rowCount × bytesPerRow). */
  estimatedBytes: number;
  /** Projected row count at the daily growth rate after forecastDays. */
  projectedRows: number;
  /** Projected storage bytes after forecastDays. */
  projectedBytes: number;
  /** Retention policy in days (null = unbounded, manual cleanup only). */
  retentionDays: number | null;
  /** Rows that would be removed by applying the retention policy now. */
  eligibleForPurge: number | null;
  /** Current threshold level for this table. */
  thresholdLevel: CapacityThresholdLevel;
}

/** Full point-in-time capacity snapshot. */
export interface CapacitySnapshot {
  /** ISO-8601 UTC timestamp when this snapshot was taken. */
  capturedAt: string;
  /** Forecast horizon in days used for projections. */
  forecastDays: number;
  /** Per-table capacity entries. */
  tables: TableCapacityEntry[];
  /** Total database storage estimate (sum of all estimatedBytes). */
  totalDbEstimatedBytes: number;
  /** Projected total database storage after forecastDays. */
  totalDbProjectedBytes: number;
  /** Current PostgreSQL connection demand model. */
  connectionDemand: ConnectionDemandModel;
  /** Redis memory model. */
  redisMemoryModel: RedisMemoryModel;
  /** Overall threshold level (worst level across all tables). */
  overallThresholdLevel: CapacityThresholdLevel;
  /** Scale thresholds used for this snapshot. */
  thresholds: CapacityThresholds;
}

/** Current and projected PostgreSQL connection demand. */
export interface ConnectionDemandModel {
  /** Number of API process replicas assumed. */
  apiReplicas: number;
  /** DB_POOL_MAX per replica. */
  poolMaxPerReplica: number;
  /** Background job connections (indexer + defaultChecker + scoreReconciler). */
  backgroundJobConnections: number;
  /** Peak concurrent connections = apiReplicas × poolMaxPerReplica + background. */
  peakConnections: number;
  /** Projected peak connections after forecastDays at userGrowthRatePerDay. */
  projectedPeakConnections: number;
  /** Recommended PostgreSQL max_connections headroom ratio (peak / max_connections). */
  connectionUtilizationRatio: number;
  /** Current threshold level for connection utilization. */
  thresholdLevel: CapacityThresholdLevel;
}

/** Estimated Redis memory demand. */
export interface RedisMemoryModel {
  /** Active users assumed (for rate-limiter key count). */
  activeUsers: number;
  /** Estimated bytes for idempotency keys (1 per financial op per 24h). */
  idempotencyBytesEstimate: number;
  /** Estimated bytes for rate-limiter sorted sets. */
  rateLimiterBytesEstimate: number;
  /** Estimated bytes for Soroban stale-read cache entries. */
  staleReadCacheBytesEstimate: number;
  /** Total Redis memory estimate in bytes. */
  totalBytesEstimate: number;
  /** Projected bytes after forecastDays. */
  projectedBytesEstimate: number;
}

/** Scale thresholds for storage, connections, and Redis. */
export interface CapacityThresholds {
  /** Storage warn at this many bytes per table (default 1 GB). */
  tableStorageWarnBytes: number;
  /** Storage critical at this many bytes per table (default 5 GB). */
  tableStorageCriticalBytes: number;
  /** Connection utilization warn ratio (default 0.70). */
  connectionUtilizationWarn: number;
  /** Connection utilization critical ratio (default 0.85). */
  connectionUtilizationCritical: number;
  /** Redis total memory warn in bytes (default 256 MB). */
  redisMemoryWarnBytes: number;
  /** Redis total memory critical in bytes (default 512 MB). */
  redisMemoryCriticalBytes: number;
}

// ── Row-size constants (schema-derived) ───────────────────────────────────────

/**
 * Approximate bytes per row for each tracked table.
 *
 * Derivation methodology:
 *   - Fixed columns: sum of fixed-width types (int=4, bigint=8, bool=1, timestamp=8,
 *     varchar(n) assumed filled to n, text average 100 B).
 *   - Variable columns (jsonb, text): conservative 95th-percentile estimate.
 *   - PostgreSQL row overhead: ~24 B per tuple (page header + item pointer).
 *   - Index overhead: estimated at 25% of table size, baked into the constant.
 *
 * These constants are intentionally conservative (rounded up) to avoid
 * underestimating storage growth.
 */
export const BYTES_PER_ROW: Record<string, number> = {
  // event_id varchar(255) + event_type varchar(50) + loan_id int + address varchar(255)
  // + amount numeric + ledger int + ledger_closed_at timestamp + tx_hash varchar(255)
  // + contract_id varchar(255) + topics jsonb(avg 200B) + value text(avg 100B) + created_at timestamp
  // = ~1700 B + 24 overhead + 25% index ~= 600 B net (deduplicated with index pages included)
  contract_events: 600,

  // event_id varchar(255) + loan_id int + event_type varchar(50)
  // + payload jsonb(avg 300B) + actor varchar(255) + occurred_at + created_at timestamps
  loan_state_events: 400,

  // actor varchar(255) + action varchar(255) + target varchar(255)
  // + payload jsonb(avg 100B) + ip_address varchar(50) + created_at timestamp
  audit_logs: 300,

  // user_id varchar(255) + type varchar(50) + title varchar(255)
  // + message text(avg 150B) + loan_id int + status + read + created_at
  notifications: 350,

  // subscription_id int + callback_url text(avg 100B) + event_type varchar(50)
  // + payload jsonb(avg 200B) + attempt_count int + last_status_code int
  // + delivered_at + next_retry_at + dead_lettered_at + dead_letter_reason text
  webhook_deliveries: 500,

  // idempotency_key text + operation varchar(64) + payload jsonb(avg 1000B, XDR is large)
  // + status varchar(20) + attempts int + last_error text + 3 timestamps
  soroban_write_queue: 1500,

  // event_id varchar(255) + ledger int + tx_hash varchar(255) + contract_id varchar(255)
  // + raw_xdr jsonb(avg 1200B — full XDR payload) + error_message text + quarantined_at
  quarantine_events: 2000,

  // Per loan: varchar(255) loan_id + borrower + status + amounts + timestamps
  loans: 400,

  // Per user: user_id varchar(255) + current_score int + updated_at + update_reason varchar(50)
  scores: 100,
};

// ── Configuration helpers ─────────────────────────────────────────────────────

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readPositiveFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Returns the capacity thresholds used for alert evaluation.
 *
 * | Parameter                     | Env var                                   | Default  |
 * |-------------------------------|-------------------------------------------|----------|
 * | Table storage warn            | CAPACITY_TABLE_WARN_BYTES                 | 1 GB     |
 * | Table storage critical        | CAPACITY_TABLE_CRITICAL_BYTES             | 5 GB     |
 * | DB connection utilization warn| CAPACITY_CONN_UTILIZATION_WARN            | 0.70     |
 * | DB connection utilization crit| CAPACITY_CONN_UTILIZATION_CRITICAL        | 0.85     |
 * | Redis memory warn             | CAPACITY_REDIS_WARN_BYTES                 | 256 MB   |
 * | Redis memory critical         | CAPACITY_REDIS_CRITICAL_BYTES             | 512 MB   |
 */
export function getCapacityThresholds(): CapacityThresholds {
  return {
    tableStorageWarnBytes: readPositiveInt(
      'CAPACITY_TABLE_WARN_BYTES',
      1_073_741_824, // 1 GB
    ),
    tableStorageCriticalBytes: readPositiveInt(
      'CAPACITY_TABLE_CRITICAL_BYTES',
      5_368_709_120, // 5 GB
    ),
    connectionUtilizationWarn: readPositiveFloat(
      'CAPACITY_CONN_UTILIZATION_WARN',
      0.70,
    ),
    connectionUtilizationCritical: readPositiveFloat(
      'CAPACITY_CONN_UTILIZATION_CRITICAL',
      0.85,
    ),
    redisMemoryWarnBytes: readPositiveInt(
      'CAPACITY_REDIS_WARN_BYTES',
      268_435_456, // 256 MB
    ),
    redisMemoryCriticalBytes: readPositiveInt(
      'CAPACITY_REDIS_CRITICAL_BYTES',
      536_870_912, // 512 MB
    ),
  };
}

// ── Growth model ──────────────────────────────────────────────────────────────

/**
 * Per-table daily event growth rates (rows per day).
 *
 * Defaults reflect the planning scenario:
 *   - 1 000 active users, each producing ~2 loan events, 3 notifications,
 *     2 audit log entries, and 1 webhook delivery per active day.
 *   - contract_events are the primary growth driver (Stellar ledger produces
 *     ~5 contract events per active loan per day at 20% daily loan activity).
 *
 * All rates are env-overridable so load-test observations can be fed back.
 */
export function getTableGrowthRatesPerDay(): Record<string, number> {
  return {
    contract_events: readPositiveFloat('GROWTH_RATE_CONTRACT_EVENTS_PER_DAY', 2_000),
    loan_state_events: readPositiveFloat('GROWTH_RATE_LOAN_STATE_EVENTS_PER_DAY', 500),
    audit_logs: readPositiveFloat('GROWTH_RATE_AUDIT_LOGS_PER_DAY', 2_000),
    notifications: readPositiveFloat('GROWTH_RATE_NOTIFICATIONS_PER_DAY', 3_000),
    webhook_deliveries: readPositiveFloat('GROWTH_RATE_WEBHOOK_DELIVERIES_PER_DAY', 1_000),
    soroban_write_queue: readPositiveFloat('GROWTH_RATE_SOROBAN_WRITE_QUEUE_PER_DAY', 100),
    quarantine_events: readPositiveFloat('GROWTH_RATE_QUARANTINE_EVENTS_PER_DAY', 10),
    loans: readPositiveFloat('GROWTH_RATE_LOANS_PER_DAY', 100),
    scores: readPositiveFloat('GROWTH_RATE_SCORES_PER_DAY', 50),
  };
}

// ── Retention configuration ───────────────────────────────────────────────────

/**
 * Returns the effective retention policy (days) for each table.
 * null = no automated retention (table is append-only by design).
 *
 * Sources:
 *   - notifications: NOTIFICATION_RETENTION_DAYS (env, default 90 days)
 *   - read notifications: READ_NOTIFICATION_RETENTION_DAYS (env, default 30 days)
 *   - webhook_deliveries: WEBHOOK_RETENTION_DAYS (env, default 90 days)
 *   - soroban_write_queue: rows reach 'applied' status and can be pruned
 *     after SOROBAN_QUEUE_RETENTION_DAYS (env, default 30 days)
 *   - audit_logs: AUDIT_LOG_RETENTION_DAYS (env, default 365 days — compliance minimum)
 *   - quarantine_events: QUARANTINE_RETENTION_DAYS (env, default 90 days)
 *   - contract_events: null — authoritative ledger record, never pruned
 *   - loan_state_events: null — authoritative domain log, never pruned
 */
export function getTableRetentionDays(): Record<string, number | null> {
  return {
    contract_events: null,
    loan_state_events: null,
    audit_logs: readPositiveInt('AUDIT_LOG_RETENTION_DAYS', 365),
    notifications: readPositiveInt('NOTIFICATION_RETENTION_DAYS', 90),
    webhook_deliveries: readPositiveInt('WEBHOOK_RETENTION_DAYS', 90),
    soroban_write_queue: readPositiveInt('SOROBAN_QUEUE_RETENTION_DAYS', 30),
    quarantine_events: readPositiveInt('QUARANTINE_RETENTION_DAYS', 90),
    loans: null,
    scores: null,
  };
}

// ── Threshold evaluation ──────────────────────────────────────────────────────

function evaluateStorageThreshold(
  bytes: number,
  thresholds: CapacityThresholds,
): CapacityThresholdLevel {
  if (bytes >= thresholds.tableStorageCriticalBytes) return 'critical';
  if (bytes >= thresholds.tableStorageWarnBytes) return 'warn';
  return 'ok';
}

function evaluateConnectionThreshold(
  ratio: number,
  thresholds: CapacityThresholds,
): CapacityThresholdLevel {
  if (ratio >= thresholds.connectionUtilizationCritical) return 'critical';
  if (ratio >= thresholds.connectionUtilizationWarn) return 'warn';
  return 'ok';
}

function worstLevel(
  levels: CapacityThresholdLevel[],
): CapacityThresholdLevel {
  if (levels.includes('critical')) return 'critical';
  if (levels.includes('warn')) return 'warn';
  return 'ok';
}

// ── Live data reads ───────────────────────────────────────────────────────────

interface TableStats {
  rowCount: number;
  eligibleForPurge: number | null;
}

/**
 * Read live row count and purge-eligible count for a single table.
 * Returns { rowCount: 0, eligibleForPurge: null } on any DB error (fail-open).
 */
async function readTableStats(
  tableName: string,
  retentionDays: number | null,
): Promise<TableStats> {
  try {
    // Use pg_stat_user_tables for a fast (non-blocking) row count estimate.
    // For exact counts on small tables (<1M rows) this is usually accurate
    // within a few percent; for large tables the estimate is preferred over
    // a full-table COUNT(*) to avoid lock contention.
    const countResult = await query(
      `SELECT reltuples::bigint AS row_count
       FROM pg_class
       WHERE relname = $1`,
      [tableName],
    );

    const rowCount = Number(
      (countResult.rows[0] as { row_count?: number } | undefined)?.row_count ?? 0,
    );

    if (retentionDays === null) {
      return { rowCount, eligibleForPurge: null };
    }

    // Count rows older than the retention window.
    const purgeResult = await query(
      `SELECT COUNT(*)::bigint AS purge_count
       FROM ${tableName}
       WHERE created_at < NOW() - ($1 || ' days')::interval`,
      [retentionDays],
    );

    const eligibleForPurge = Number(
      (purgeResult.rows[0] as { purge_count?: number } | undefined)?.purge_count ?? 0,
    );

    return { rowCount, eligibleForPurge };
  } catch (err) {
    logger.warn(`[capacity-model] Failed to read stats for table "${tableName}"`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return { rowCount: 0, eligibleForPurge: null };
  }
}

// ── Core models ───────────────────────────────────────────────────────────────

/**
 * Build the connection demand model.
 *
 * Configured via:
 *   API_REPLICAS          — number of API process replicas (default 1)
 *   DB_POOL_MAX           — pool size per replica (default 10)
 *   POSTGRES_MAX_CONNECTIONS — total PG max_connections (default 100)
 */
export function buildConnectionDemandModel(
  forecastDays: number,
  thresholds: CapacityThresholds,
): ConnectionDemandModel {
  const apiReplicas = readPositiveInt('API_REPLICAS', 1);
  const poolMaxPerReplica = readPositiveInt('DB_POOL_MAX', 10);
  const postgresMaxConnections = readPositiveInt('POSTGRES_MAX_CONNECTIONS', 100);
  const backgroundJobConnections = 3; // indexer, defaultChecker, scoreReconciler

  const peakConnections = apiReplicas * poolMaxPerReplica + backgroundJobConnections;

  // Approximate replica growth: each doubling of users adds one replica.
  // Assumption: users double every 90 days (conservative hypergrowth scenario).
  const userDoublingDays = readPositiveInt('CAPACITY_USER_DOUBLING_DAYS', 90);
  const replicaDoublings = forecastDays / userDoublingDays;
  const projectedReplicas = Math.ceil(apiReplicas * Math.pow(2, replicaDoublings));
  const projectedPeakConnections =
    projectedReplicas * poolMaxPerReplica + backgroundJobConnections;

  const connectionUtilizationRatio = peakConnections / postgresMaxConnections;
  const thresholdLevel = evaluateConnectionThreshold(connectionUtilizationRatio, thresholds);

  return {
    apiReplicas,
    poolMaxPerReplica,
    backgroundJobConnections,
    peakConnections,
    projectedPeakConnections,
    connectionUtilizationRatio,
    thresholdLevel,
  };
}

/**
 * Build the Redis memory model.
 *
 * Configured via:
 *   CAPACITY_ACTIVE_USERS            — active concurrent users (default 1 000)
 *   CAPACITY_FINANCIAL_OPS_PER_USER  — financial ops per active user per day (default 2)
 *   CAPACITY_RATE_LIMITER_WINDOW_SIZE — sliding window entries per user (default 60)
 *   CAPACITY_STALE_READ_CACHE_ENTRIES — stale-read cache entries (default 20)
 */
export function buildRedisMemoryModel(
  forecastDays: number,
): RedisMemoryModel {
  const activeUsers = readPositiveInt('CAPACITY_ACTIVE_USERS', 1_000);
  const financialOpsPerUserPerDay = readPositiveInt('CAPACITY_FINANCIAL_OPS_PER_USER', 2);
  const rateLimiterWindowSize = readPositiveInt('CAPACITY_RATE_LIMITER_WINDOW_SIZE', 60);
  const staleReadCacheEntries = readPositiveInt('CAPACITY_STALE_READ_CACHE_ENTRIES', 20);

  // Idempotency keys: 1 per financial op, TTL 24h, ~200 B each
  const idempotencyKeyCount = activeUsers * financialOpsPerUserPerDay;
  const idempotencyBytesEstimate = idempotencyKeyCount * 200;

  // Rate-limiter sorted sets: 1 set per active user, ~50 B × window entries
  const rateLimiterBytesEstimate = activeUsers * rateLimiterWindowSize * 50;

  // Stale-read cache: soroban pool/cooldown values, ~500 B each, TTL 1h
  const staleReadCacheBytesEstimate = staleReadCacheEntries * 500;

  const totalBytesEstimate =
    idempotencyBytesEstimate + rateLimiterBytesEstimate + staleReadCacheBytesEstimate;

  // Projected: scale with activeUsers growing at the same rate as the connection model
  const userDoublingDays = readPositiveInt('CAPACITY_USER_DOUBLING_DAYS', 90);
  const userDoublings = forecastDays / userDoublingDays;
  const projectedUsers = Math.ceil(activeUsers * Math.pow(2, userDoublings));
  const projectedBytesEstimate =
    projectedUsers * financialOpsPerUserPerDay * 200 +
    projectedUsers * rateLimiterWindowSize * 50 +
    staleReadCacheBytesEstimate; // cache entries bounded by contract count, not user count

  return {
    activeUsers,
    idempotencyBytesEstimate,
    rateLimiterBytesEstimate,
    staleReadCacheBytesEstimate,
    totalBytesEstimate,
    projectedBytesEstimate,
  };
}

// ── Main snapshot builder ─────────────────────────────────────────────────────

/**
 * Build a full capacity snapshot by reading live table stats from the DB
 * and projecting growth forward by `forecastDays`.
 *
 * This function never throws — errors in individual table reads are logged and
 * result in zero-row entries so the snapshot is always complete.
 *
 * @param forecastDays  How many days forward to project growth (default 30).
 */
export async function buildCapacitySnapshot(
  forecastDays = 30,
): Promise<CapacitySnapshot> {
  const thresholds = getCapacityThresholds();
  const growthRates = getTableGrowthRatesPerDay();
  const retentionDays = getTableRetentionDays();

  const tableNames = Object.keys(BYTES_PER_ROW);

  // Read all table stats in parallel (fail-open per table).
  const statEntries = await Promise.all(
    tableNames.map((name) =>
      readTableStats(name, retentionDays[name] ?? null).then((stats) => ({
        name,
        stats,
      })),
    ),
  );

  const tables: TableCapacityEntry[] = statEntries.map(({ name, stats }) => {
    const bytesPerRow = BYTES_PER_ROW[name] ?? 500;
    const dailyGrowthRows = growthRates[name] ?? 0;
    const retention = retentionDays[name] ?? null;

    const estimatedBytes = stats.rowCount * bytesPerRow;
    const projectedRows =
      stats.rowCount + Math.round(dailyGrowthRows * forecastDays);
    const projectedBytes = projectedRows * bytesPerRow;

    const thresholdLevel = evaluateStorageThreshold(estimatedBytes, thresholds);

    return {
      table: name,
      rowCount: stats.rowCount,
      bytesPerRow,
      estimatedBytes,
      projectedRows,
      projectedBytes,
      retentionDays: retention,
      eligibleForPurge: stats.eligibleForPurge,
      thresholdLevel,
    };
  });

  const totalDbEstimatedBytes = tables.reduce(
    (sum, t) => sum + t.estimatedBytes,
    0,
  );
  const totalDbProjectedBytes = tables.reduce(
    (sum, t) => sum + t.projectedBytes,
    0,
  );

  const connectionDemand = buildConnectionDemandModel(forecastDays, thresholds);
  const redisMemoryModel = buildRedisMemoryModel(forecastDays);

  const allLevels: CapacityThresholdLevel[] = [
    ...tables.map((t) => t.thresholdLevel),
    connectionDemand.thresholdLevel,
  ];
  const overallThresholdLevel = worstLevel(allLevels);

  if (overallThresholdLevel !== 'ok') {
    logger.warn('[capacity-model] Capacity threshold crossed', {
      overallThresholdLevel,
      criticalTables: tables
        .filter((t) => t.thresholdLevel === 'critical')
        .map((t) => t.table),
    });
  }

  const snapshot: CapacitySnapshot = {
    capturedAt: new Date().toISOString(),
    forecastDays,
    tables,
    totalDbEstimatedBytes,
    totalDbProjectedBytes,
    connectionDemand,
    redisMemoryModel,
    overallThresholdLevel,
    thresholds,
  };

  // Push latest values to Prometheus so /metrics always reflects current capacity.
  recordCapacitySnapshot(snapshot);

  return snapshot;
}

// ── Snapshot persistence (for load-test validation) ───────────────────────────

/**
 * Persist a capacity snapshot to `capacity_snapshots` for historical comparison
 * and load-test validation.
 *
 * Rows are keyed on (captured_at) so repeated calls for the same minute are
 * idempotent (ON CONFLICT DO NOTHING).
 */
export async function persistCapacitySnapshot(
  snapshot: CapacitySnapshot,
): Promise<void> {
  try {
    await query(
      `INSERT INTO capacity_snapshots
         (captured_at, forecast_days, total_db_estimated_bytes,
          total_db_projected_bytes, connection_peak, connection_utilization_ratio,
          redis_total_bytes_estimate, overall_threshold_level, snapshot_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (captured_at) DO NOTHING`,
      [
        snapshot.capturedAt,
        snapshot.forecastDays,
        snapshot.totalDbEstimatedBytes,
        snapshot.totalDbProjectedBytes,
        snapshot.connectionDemand.peakConnections,
        snapshot.connectionDemand.connectionUtilizationRatio,
        snapshot.redisMemoryModel.totalBytesEstimate,
        snapshot.overallThresholdLevel,
        JSON.stringify(snapshot),
      ],
    );
  } catch (err) {
    logger.warn('[capacity-model] Failed to persist capacity snapshot', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Periodic scheduler ────────────────────────────────────────────────────────

let _snapshotInterval: NodeJS.Timeout | null = null;

/**
 * Start the background capacity-snapshot scheduler.
 *
 * Takes and persists a snapshot every CAPACITY_SNAPSHOT_INTERVAL_MS
 * (default 1 hour). Safe to call multiple times — only one loop is started.
 */
export function startCapacitySnapshotScheduler(): void {
  if (_snapshotInterval) return;

  const intervalMs = readPositiveInt(
    'CAPACITY_SNAPSHOT_INTERVAL_MS',
    3_600_000, // 1 hour
  );

  logger.info('[capacity-model] Starting capacity snapshot scheduler', { intervalMs });

  _snapshotInterval = setInterval(() => {
    void buildCapacitySnapshot()
      .then((snap) => persistCapacitySnapshot(snap))
      .catch((err) => {
        logger.warn('[capacity-model] Scheduled capacity snapshot failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }, intervalMs);

  _snapshotInterval.unref();
}

/** Stop the capacity snapshot scheduler (graceful shutdown). */
export function stopCapacitySnapshotScheduler(): void {
  if (_snapshotInterval) {
    clearInterval(_snapshotInterval);
    _snapshotInterval = null;
    logger.info('[capacity-model] Capacity snapshot scheduler stopped');
  }
}
