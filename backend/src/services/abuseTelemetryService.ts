import crypto from 'node:crypto';
import { query } from '../db/connection.js';
import { cacheService } from './cacheService.js';
import logger from '../utils/logger.js';
import {
  ABUSE_TELEMETRY_BLOCK_THRESHOLD,
  ABUSE_TELEMETRY_WINDOW_MS,
  DEFAULT_ABUSE_TELEMETRY_RETENTION_DAYS,
  type AbuseDecision,
  type AbuseMutationType,
  type AbuseOutcome,
  type AbuseRateBand,
  type AbuseRiskTier,
  type AbuseTelemetryEvent,
  type AbuseTelemetryPublicEvent,
  type AbuseTelemetryQuery,
} from '../schemas/abuseTelemetrySchemas.js';

export interface AttemptCounter {
  increment(key: string, windowMs: number): Promise<number>;
}

export interface QueryResult {
  rows: Array<Record<string, unknown>>;
  rowCount?: number | null;
}

export type QueryFn = (sql: string, values: unknown[]) => Promise<QueryResult>;

export interface AbuseTelemetryDeps {
  counter?: AttemptCounter;
  queryFn?: QueryFn;
  now?: () => Date;
  pepper?: string;
  retentionDays?: number;
  blockThreshold?: number;
}

export interface EvaluateInput {
  actorId: string;
  mutationType: AbuseMutationType;
  isReplay?: boolean;
}

export interface Evaluation {
  actorHash: string;
  attemptsInWindow: number;
  rateBand: AbuseRateBand;
  riskTier: AbuseRiskTier;
  decision: AbuseDecision;
  dependencyError: boolean;
}

export interface RecordInput {
  eventId?: string;
  actorHash: string;
  mutationType: AbuseMutationType;
  decision: AbuseDecision;
  outcome: AbuseOutcome;
  riskTier: AbuseRiskTier;
  rateBand: AbuseRateBand;
  attemptsInWindow: number;
  occurredAt?: Date;
}

export interface AbuseSummary {
  total: number;
  blocked: number;
  byOutcome: Record<AbuseOutcome, number>;
  byRiskTier: Record<AbuseRiskTier, number>;
}

export interface AbuseTelemetryReport {
  retentionDays: number;
  summary: AbuseSummary;
  events: AbuseTelemetryPublicEvent[];
}

class CacheAttemptCounter implements AttemptCounter {
  async increment(key: string, windowMs: number): Promise<number> {
    const current = await cacheService.get<number>(key);
    const next = typeof current === 'number' && Number.isFinite(current) ? current + 1 : 1;
    await cacheService.set(key, next, Math.max(1, Math.ceil(windowMs / 1000)));
    return next;
  }
}

const configuredPepper = process.env.ABUSE_TELEMETRY_PEPPER;
const ephemeralPepper = crypto.randomBytes(32).toString('hex');
const DEFAULT_PEPPER = configuredPepper ?? ephemeralPepper;

if (!configuredPepper && process.env.NODE_ENV === 'production') {
  logger.warn(
    'ABUSE_TELEMETRY_PEPPER is not configured; actor references will not correlate across restarts',
  );
}

export function bucketRate(attempts: number): AbuseRateBand {
  if (attempts <= 1) return 'one';
  if (attempts <= 5) return 'few';
  if (attempts <= 20) return 'many';
  return 'burst';
}

export function deriveRiskTier(rateBand: AbuseRateBand): AbuseRiskTier {
  if (rateBand === 'burst') return 'high';
  if (rateBand === 'many') return 'medium';
  return 'low';
}

export class AbuseTelemetryService {
  private readonly counter: AttemptCounter;
  private readonly queryFn: QueryFn;
  private readonly now: () => Date;
  private readonly pepper: string;
  private readonly retentionDays: number;
  private readonly blockThreshold: number;

  constructor(deps: AbuseTelemetryDeps = {}) {
    this.counter = deps.counter ?? new CacheAttemptCounter();
    this.queryFn = deps.queryFn ?? query;
    this.now = deps.now ?? (() => new Date());
    this.pepper = deps.pepper ?? DEFAULT_PEPPER;
    this.retentionDays =
      deps.retentionDays ??
      parsePositiveInt(
        process.env.ABUSE_TELEMETRY_RETENTION_DAYS,
        DEFAULT_ABUSE_TELEMETRY_RETENTION_DAYS,
      );
    this.blockThreshold =
      deps.blockThreshold ??
      parsePositiveInt(
        process.env.ABUSE_TELEMETRY_BLOCK_THRESHOLD,
        ABUSE_TELEMETRY_BLOCK_THRESHOLD,
      );
  }

  deriveActorHash(actorId: string, at: Date = this.now()): string {
    const day = at.toISOString().slice(0, 10);
    return crypto.createHash('sha256').update(`${this.pepper}\n${day}\n${actorId}`).digest('hex');
  }

  async evaluate(input: EvaluateInput): Promise<Evaluation> {
    const at = this.now();
    const actorHash = this.deriveActorHash(input.actorId, at);

    if (input.isReplay) {
      return {
        actorHash,
        attemptsInWindow: 1,
        rateBand: 'one',
        riskTier: 'low',
        decision: 'allow',
        dependencyError: false,
      };
    }

    const key = `abuse:${Math.floor(at.getTime() / ABUSE_TELEMETRY_WINDOW_MS)}:${actorHash.slice(0, 24)}:${input.mutationType}`;

    let attemptsInWindow: number;
    let dependencyError = false;
    try {
      attemptsInWindow = await this.counter.increment(key, ABUSE_TELEMETRY_WINDOW_MS);
    } catch (error) {
      dependencyError = true;
      attemptsInWindow = 1;
      logger.warn('Abuse telemetry counter unavailable; failing open', {
        mutationType: input.mutationType,
        error,
      });
    }

    const rateBand = bucketRate(attemptsInWindow);
    const riskTier = deriveRiskTier(rateBand);
    const decision: AbuseDecision = attemptsInWindow > this.blockThreshold ? 'block' : 'allow';

    return { actorHash, attemptsInWindow, rateBand, riskTier, decision, dependencyError };
  }

  async record(input: RecordInput): Promise<boolean> {
    const occurredAt = input.occurredAt ?? this.now();
    const expiresAt = new Date(occurredAt.getTime() + this.retentionDays * 24 * 60 * 60 * 1000);

    const event: AbuseTelemetryEvent = {
      eventId: input.eventId ?? crypto.randomUUID(),
      actorHash: input.actorHash,
      mutationType: input.mutationType,
      decision: input.decision,
      outcome: input.outcome,
      riskTier: input.riskTier,
      rateBand: input.rateBand,
      attemptsInWindow: input.attemptsInWindow,
      occurredAt: occurredAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };

    try {
      await this.queryFn(
        `INSERT INTO abuse_telemetry_events
           (event_id, actor_hash, mutation_type, decision, outcome, risk_tier,
            rate_band, attempts_in_window, occurred_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (event_id) DO NOTHING`,
        [
          event.eventId,
          event.actorHash,
          event.mutationType,
          event.decision,
          event.outcome,
          event.riskTier,
          event.rateBand,
          event.attemptsInWindow,
          event.occurredAt,
          event.expiresAt,
        ],
      );
      return true;
    } catch (error) {
      logger.warn('Failed to persist abuse telemetry event', {
        mutationType: event.mutationType,
        outcome: event.outcome,
        error,
      });
      return false;
    }
  }

  async getReport(filters: AbuseTelemetryQuery = {}): Promise<AbuseTelemetryReport> {
    const params: unknown[] = [
      filters.mutationType ?? null,
      filters.outcome ?? null,
      filters.riskTier ?? null,
    ];
    const where = `WHERE expires_at > NOW()
      AND ($1::text IS NULL OR mutation_type = $1)
      AND ($2::text IS NULL OR outcome = $2)
      AND ($3::text IS NULL OR risk_tier = $3)`;

    const eventsResult = await this.queryFn(
      `SELECT mutation_type, decision, outcome, risk_tier, rate_band, attempts_in_window, occurred_at
         FROM abuse_telemetry_events
         ${where}
        ORDER BY occurred_at DESC
        LIMIT $4`,
      [...params, filters.limit ?? 50],
    );

    const summaryResult = await this.queryFn(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE decision = 'block')::int AS blocked,
         COUNT(*) FILTER (WHERE outcome = 'success')::int AS success,
         COUNT(*) FILTER (WHERE outcome = 'failure')::int AS failure,
         COUNT(*) FILTER (WHERE outcome = 'blocked')::int AS outcome_blocked,
         COUNT(*) FILTER (WHERE risk_tier = 'low')::int AS low,
         COUNT(*) FILTER (WHERE risk_tier = 'medium')::int AS medium,
         COUNT(*) FILTER (WHERE risk_tier = 'high')::int AS high
         FROM abuse_telemetry_events
         ${where}`,
      params,
    );

    const row = summaryResult.rows[0] ?? {};
    const num = (value: unknown): number => Number(value ?? 0);

    const events: AbuseTelemetryPublicEvent[] = eventsResult.rows.map((r) => ({
      mutationType: String(r.mutation_type) as AbuseMutationType,
      decision: String(r.decision) as AbuseDecision,
      outcome: String(r.outcome) as AbuseOutcome,
      riskTier: String(r.risk_tier) as AbuseRiskTier,
      rateBand: String(r.rate_band) as AbuseRateBand,
      attemptsInWindow: num(r.attempts_in_window),
      occurredAt:
        r.occurred_at instanceof Date ? r.occurred_at.toISOString() : String(r.occurred_at),
    }));

    return {
      retentionDays: this.retentionDays,
      summary: {
        total: num(row.total),
        blocked: num(row.blocked),
        byOutcome: {
          success: num(row.success),
          failure: num(row.failure),
          blocked: num(row.outcome_blocked),
        },
        byRiskTier: {
          low: num(row.low),
          medium: num(row.medium),
          high: num(row.high),
        },
      },
      events,
    };
  }

  async purgeExpired(): Promise<number> {
    const result = await this.queryFn(
      'DELETE FROM abuse_telemetry_events WHERE expires_at <= NOW()',
      [],
    );
    return result.rowCount ?? 0;
  }
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const abuseTelemetryService = new AbuseTelemetryService();

let purgeInterval: ReturnType<typeof setInterval> | undefined;

export function startAbuseTelemetryRetentionScheduler(): void {
  if (purgeInterval) return;

  const intervalMs = parsePositiveInt(
    process.env.ABUSE_TELEMETRY_PURGE_INTERVAL_MS,
    24 * 60 * 60 * 1000,
  );

  void abuseTelemetryService.purgeExpired().catch((error) => {
    logger.warn('Initial abuse telemetry retention purge failed', { error });
  });

  purgeInterval = setInterval(() => {
    void abuseTelemetryService.purgeExpired().catch((error) => {
      logger.warn('Abuse telemetry retention purge failed', { error });
    });
  }, intervalMs);
}

export function stopAbuseTelemetryRetentionScheduler(): void {
  if (purgeInterval) {
    clearInterval(purgeInterval);
    purgeInterval = undefined;
  }
}
