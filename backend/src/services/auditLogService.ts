import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { query, withTransaction, type PoolClient } from '../db/connection.js';
import logger from '../utils/logger.js';

export interface AuditLogEntry {
  action: string;
  actor: string;
  target?: string;
  metadata?: Record<string, unknown>;
}

export const auditLogService = {
  async log(entry: AuditLogEntry): Promise<void> {
    await query(
      `INSERT INTO audit_logs (actor, action, target, payload, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [
        entry.actor,
        entry.action,
        entry.target ?? null,
        entry.metadata ? JSON.stringify(entry.metadata) : null,
      ],
    );
  },
};

export interface AuditLogFilters {
  actor?: string;
  action?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
  withTotal?: boolean;
}

export async function getAuditLogs(filters: AuditLogFilters) {
  const { actor, action, from, to, cursor, limit = 25, withTotal } = filters;

  const conditions: string[] = [];
  const values: unknown[] = [];

  if (actor) {
    conditions.push(`actor = $${values.length + 1}`);
    values.push(actor);
  }

  if (action) {
    conditions.push(`action = $${values.length + 1}`);
    values.push(action);
  }

  if (from) {
    conditions.push(`created_at >= $${values.length + 1}`);
    values.push(from);
  }

  if (to) {
    conditions.push(`created_at <= $${values.length + 1}`);
    values.push(to);
  }

  if (cursor) {
    conditions.push(`id < $${values.length + 1}`);
    values.push(cursor);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  values.push(limit + 1);
  const result = await query(
    `SELECT * FROM audit_logs ${whereClause} ORDER BY created_at DESC LIMIT $${values.length}`,
    values,
  );

  const rows = result.rows as Array<Record<string, unknown>>;
  const hasNext = rows.length > limit;
  const data = rows.slice(0, limit);

  let total: number | undefined;
  if (withTotal === true) {
    const countResult = await query('SELECT COUNT(*) as count FROM audit_logs');
    total = Number((countResult.rows[0] as Record<string, unknown>)?.count ?? 0);
  }

  return {
    data,
    nextCursor: hasNext ? String((data[data.length - 1] as Record<string, unknown>).id) : null,
    total,
  };
}

export const auditLogService = {
  async log(entry: {
    action: string;
    actor: string;
    target?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await query(
      `INSERT INTO audit_logs (actor, action, target, payload, status)
       VALUES ($1, $2, $3, $4, 'success')`,
      [entry.actor, entry.action, entry.target ?? null, JSON.stringify(entry.metadata ?? {})],
    );
  },
};
// ─── Tamper-evident HMAC chain (#796) ────────────────────────────────────────

/** prev_hmac of the first chained entry. Public and deterministic by design. */
export const AUDIT_GENESIS_HMAC = createHash('sha256')
  .update('remitlend:audit-log:genesis:v1')
  .digest('hex');

/** Arbitrary constant used to serialise chain appends across connections. */
const AUDIT_CHAIN_LOCK_ID = 794_796_001;
const DEV_FALLBACK_KEY = 'dev-only-audit-log-key-do-not-use-in-production';

let warnedFallback = false;

/**
 * Resolve AUDIT_LOG_KEY. It must be a distinct secret from JWT_SECRET so a
 * leaked session-signing key cannot be used to re-forge the audit chain.
 */
export function getAuditLogKey(env: NodeJS.ProcessEnv = process.env): string {
  const key = env.AUDIT_LOG_KEY?.trim();
  if (!key) {
    if (env.NODE_ENV === 'production') {
      throw new Error('AUDIT_LOG_KEY is required in production');
    }
    if (!warnedFallback) {
      warnedFallback = true;
      logger.warn('AUDIT_LOG_KEY not set; using an insecure development key');
    }
    return DEV_FALLBACK_KEY;
  }
  if (key.length < 32) {
    throw new Error('AUDIT_LOG_KEY must be at least 32 characters');
  }
  if (env.JWT_SECRET && key === env.JWT_SECRET) {
    throw new Error('AUDIT_LOG_KEY must differ from JWT_SECRET');
  }
  return key;
}

export interface ChainFields {
  id: number | string;
  actor: string;
  action: string;
  /** The audit row's `target` column. */
  resource: string | null;
  createdAt: Date | string;
}

function canonicalTimestamp(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

/** HMAC-SHA256(prev_hmac || log_id || actor || action || resource || timestamp, key). */
export function computeAuditHmac(prevHmac: string, entry: ChainFields, key: string): string {
  const message = [
    prevHmac,
    String(entry.id),
    entry.actor,
    entry.action,
    entry.resource ?? '',
    canonicalTimestamp(entry.createdAt),
  ].join('|');
  return createHmac('sha256', key).update(message).digest('hex');
}

export interface AppendAuditLogInput {
  actor: string;
  action: string;
  target?: string | null;
  payload?: unknown;
  ipAddress?: string | null;
  status?: number | null;
}

type Queryable = Pick<PoolClient, 'query'>;

/**
 * Append one audit entry to the HMAC chain using the caller's transaction
 * client, so the audit row commits or rolls back with the audited change.
 * An advisory transaction lock serialises appends so concurrent writers can
 * never fork the chain. The caller MUST be inside a transaction.
 */
export async function appendAuditLogWithClient(
  client: Queryable,
  input: AppendAuditLogInput,
): Promise<{ id: number; hmac: string } | null> {
  const key = getAuditLogKey();
  await client.query('SELECT pg_advisory_xact_lock($1)', [AUDIT_CHAIN_LOCK_ID]);

  const prevResult = await client.query(
    'SELECT hmac FROM audit_logs WHERE hmac IS NOT NULL ORDER BY id DESC LIMIT 1',
  );
  const prevHmac =
    (prevResult?.rows?.[0]?.hmac as string | undefined)?.trim() ?? AUDIT_GENESIS_HMAC;
  // Millisecond precision so the stored value round-trips through JS Date exactly.
  const createdAt = new Date();
  const target = input.target ?? null;

  const inserted = await client.query(
    `INSERT INTO audit_logs (actor, action, target, payload, ip_address, status, created_at, prev_hmac)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)
     RETURNING id`,
    [
      input.actor,
      input.action,
      target,
      input.payload === undefined || input.payload === null ? null : JSON.stringify(input.payload),
      input.ipAddress ?? null,
      input.status ?? null,
      createdAt,
      prevHmac,
    ],
  );
  const rawId = inserted?.rows?.[0]?.id;
  if (rawId === undefined || rawId === null) return null;
  const id = Number(rawId);

  const hmac = computeAuditHmac(
    prevHmac,
    { id, actor: input.actor, action: input.action, resource: target, createdAt },
    key,
  );
  await client.query('UPDATE audit_logs SET hmac = $1 WHERE id = $2', [hmac, id]);
  return { id, hmac };
}

/** Append one audit entry to the HMAC chain in its own transaction. */
export async function appendAuditLog(
  input: AppendAuditLogInput,
): Promise<{ id: number; hmac: string } | null> {
  return withTransaction((client) => appendAuditLogWithClient(client, input));
}

export interface AuditRange {
  from?: string;
  to?: string;
}

export interface AuditChainRow {
  id: number | string;
  actor: string;
  action: string;
  target: string | null;
  payload?: unknown;
  ip_address?: string | null;
  status?: number | null;
  created_at: Date | string;
  prev_hmac: string | null;
  hmac: string | null;
}

const EXPORT_BATCH_SIZE = 500;

/**
 * Yield audit rows in id order for the range using keyset pagination, so
 * export/verify hold at most one batch in memory regardless of range size.
 */
export async function* iterateAuditLogs(
  range: AuditRange,
  batchSize = EXPORT_BATCH_SIZE,
): AsyncGenerator<AuditChainRow> {
  let afterId = 0;
  for (;;) {
    const conditions = ['id > $1'];
    const values: unknown[] = [afterId];
    if (range.from) {
      values.push(range.from);
      conditions.push(`created_at >= $${values.length}`);
    }
    if (range.to) {
      values.push(range.to);
      conditions.push(`created_at <= $${values.length}`);
    }
    values.push(batchSize);
    const result = await query(
      `SELECT id, actor, action, target, payload, ip_address, status, created_at, prev_hmac, hmac
         FROM audit_logs WHERE ${conditions.join(' AND ')}
        ORDER BY id ASC LIMIT $${values.length}`,
      values,
    );
    const rows = result.rows as AuditChainRow[];
    for (const row of rows) yield row;
    if (rows.length < batchSize) return;
    afterId = Number(rows[rows.length - 1]!.id);
  }
}

export interface ChainVerificationResult {
  valid: boolean;
  checked: number;
  /** Rows predating the chain (NULL hmac before the first chained row). */
  legacyUnchained: number;
  firstBrokenLink: null | {
    id: number;
    reason: 'missing_hmac' | 'prev_hmac_mismatch' | 'hmac_mismatch';
    expectedPrevHmac?: string;
  };
}

function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Verify a sequence of rows (ascending id). `anchorHmac` is the hmac of the
 * last chained row before the range, or the genesis hash. A deleted row shows
 * up as a prev_hmac mismatch on its successor; an edited row as an hmac
 * mismatch on itself.
 */
export async function verifyAuditChain(
  rows: AsyncIterable<AuditChainRow> | Iterable<AuditChainRow>,
  anchorHmac: string | null,
  key: string = getAuditLogKey(),
): Promise<ChainVerificationResult> {
  let expectedPrev = anchorHmac;
  let checked = 0;
  let legacyUnchained = 0;

  for await (const row of rows as AsyncIterable<AuditChainRow>) {
    const id = Number(row.id);
    const hmac = row.hmac?.trim() ?? null;
    const prev = row.prev_hmac?.trim() ?? null;

    if (!hmac) {
      if (expectedPrev === null) {
        legacyUnchained++;
        continue;
      }
      return {
        valid: false,
        checked,
        legacyUnchained,
        firstBrokenLink: { id, reason: 'missing_hmac' },
      };
    }

    // First chained row in a range with no anchor: must start at genesis.
    const expected = expectedPrev ?? AUDIT_GENESIS_HMAC;
    if (!prev || !safeEqualHex(prev, expected)) {
      return {
        valid: false,
        checked,
        legacyUnchained,
        firstBrokenLink: { id, reason: 'prev_hmac_mismatch', expectedPrevHmac: expected },
      };
    }

    const recomputed = computeAuditHmac(
      prev,
      { id, actor: row.actor, action: row.action, resource: row.target, createdAt: row.created_at },
      key,
    );
    if (!safeEqualHex(recomputed, hmac)) {
      return {
        valid: false,
        checked,
        legacyUnchained,
        firstBrokenLink: { id, reason: 'hmac_mismatch' },
      };
    }

    expectedPrev = hmac;
    checked++;
  }

  return { valid: true, checked, legacyUnchained, firstBrokenLink: null };
}

/**
 * hmac of the last chained row strictly before the range start, or null when
 * the range starts at (or before) the beginning of the chain.
 */
export async function getChainAnchor(range: AuditRange): Promise<string | null> {
  if (!range.from) return null;
  const result = await query(
    `SELECT hmac FROM audit_logs
      WHERE hmac IS NOT NULL
        AND id < COALESCE((SELECT MIN(id) FROM audit_logs WHERE created_at >= $1), 9223372036854775807)
      ORDER BY id DESC LIMIT 1`,
    [range.from],
  );
  return (result.rows[0]?.hmac as string | undefined)?.trim() ?? null;
}

/** Verify the stored chain over a created_at range. */
export async function verifyAuditRange(range: AuditRange): Promise<ChainVerificationResult> {
  const key = getAuditLogKey();
  const anchor = await getChainAnchor(range);
  return verifyAuditChain(iterateAuditLogs(range), anchor, key);
}
