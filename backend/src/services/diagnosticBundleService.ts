import { createHmac, timingSafeEqual } from 'crypto';
import { Pool } from 'pg';
import { deepRedact } from '../utils/logger.js';
import { maskValue } from './piiCrypto.js';
import { auditLogService } from './auditLogService.js';
import { deepRedact } from '../utils/logger';
import { maskValue } from '../utils/masking.js';
import { auditLogService } from './auditLogService';
import { ledgerCheckpoints } from './ledgerCheckpoints';
import { loanStateEventStore } from './loanStateEventStore';
import { remittanceService } from './remittanceService';
import { sorobanService } from './sorobanService';
import { webhookDeliveryService } from './webhookDeliveryService';

/**
 * Diagnostic bundle service.
 *
 * Generates privacy-safe, user-authorized diagnostic bundles for a single
 * transaction. Only allowlisted fields are ever exported; every string is run
 * through a redaction pass before serialization. Bundles expire after a short,
 * documented period (default 24h).
 */

export const DIAGNOSTIC_BUNDLE_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
/** Admin loan bundles are retained for 7 days. */
export const LOAN_BUNDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Deterministic JSON (sorted keys) so signatures are reproducible offline. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(',')}}`;
}

function bundleSecret(): string {
  const secret = process.env.DIAGNOSTIC_BUNDLE_HMAC_SECRET || process.env.JWT_SECRET;
  if (!secret) throw new Error('DIAGNOSTIC_BUNDLE_HMAC_SECRET or JWT_SECRET must be set');
  return secret;
}

export function signBundle(bundle: unknown, secret: string = bundleSecret()): string {
  return createHmac('sha256', secret).update(canonicalJson(bundle)).digest('hex');
}

export function verifyBundleSignature(
  bundle: unknown,
  signature: string,
  secret: string = bundleSecret(),
): boolean {
  const expected = Buffer.from(signBundle(bundle, secret), 'hex');
  const actual = Buffer.from(signature || '', 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export interface LoanDiagnosticBundle {
  bundleId: string;
  loanId: number;
  createdAt: string;
  expiresAt: string;
  loan: Record<string, unknown>;
  events: Record<string, unknown>[];
  transactions: Record<string, unknown>[];
  notifications: Record<string, unknown>[];
  auditLogs: Record<string, unknown>[];
  scoreHistory: Record<string, unknown>[];
}

export interface SignedLoanBundle {
  bundle: LoanDiagnosticBundle;
  signature: string;
  algorithm: 'HMAC-SHA256';
}

/**
 * Incident evidence bundle defaults. Evidence bundles are bounded in size and
 * time-limited so they can be shared with responders without leaking PII or
 * unbounded log volume.
 */
export const INCIDENT_EVIDENCE_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
export const INCIDENT_EVIDENCE_MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const INCIDENT_EVIDENCE_MAX_BYTES = 512 * 1024;
export const INCIDENT_EVIDENCE_MAX_REFERENCES = 200;

/**
 * The schema allowlist. Every exported field MUST be declared here. There is
 * no arbitrary log or database dump path.
 */
export const DIAGNOSTIC_BUNDLE_SCHEMA = {
  bundleId: 'string',
  createdAt: 'string',
  expiresAt: 'string',
  transaction: {
    id: 'string',
    txHash: 'string',
    status: 'string',
    submittedAt: 'string',
    updatedAt: 'string',
    transactionType: 'string',
    failureCategory: 'string',
  },
  auditCorrelation: 'array',
  appVersion: 'string',
} as const;

export type DiagnosticFailureCategory =
  'none' | 'pending' | 'validation' | 'network' | 'insufficient_funds' | 'rejected' | 'unknown';

export interface DiagnosticBundleTransaction {
  id: string;
  txHash: string;
  status: string;
  submittedAt: string;
  updatedAt: string;
  transactionType: string;
  failureCategory: DiagnosticFailureCategory;
}

export interface DiagnosticAuditCorrelation {
  action: string;
  target: string;
  createdAt: string;
}

export interface DiagnosticBundle {
  bundleId: string;
  createdAt: string;
  expiresAt: string;
  transaction: DiagnosticBundleTransaction;
  auditCorrelation: DiagnosticAuditCorrelation[];
  appVersion: string;
}

export interface DiagnosticBundleRow {
  id: string;
  transaction_id: string;
  submitted_by: string;
  bundle: DiagnosticBundle;
  created_at: Date;
  expires_at: Date;
}

export interface CreateDiagnosticBundleOptions {
  ttlMs?: number;
  appVersion?: string;
  auditActions?: string[];
}

/**
 * A single bounded reference inside an incident evidence bundle. References
 * are pointers (ids, checkpoints, state keys) — never raw payloads.
 */
export interface IncidentEvidenceReference {
  kind: 'request' | 'trace' | 'checkpoint' | 'state';
  source: string;
  ref: string;
  capturedAt: string;
}

export interface IncidentEvidenceBundle {
  incidentId: string;
  createdAt: string;
  expiresAt: string;
  accessScope: string;
  redactedByDefault: true;
  references: IncidentEvidenceReference[];
  appVersion: string;
}

export interface IncidentEvidenceBundleRow {
  incident_id: string;
  created_by: string;
  access_scope: string;
  bundle: IncidentEvidenceBundle | string;
  created_at: Date;
  expires_at: Date;
}

export interface CreateIncidentEvidenceBundleOptions {
  ttlMs?: number;
  appVersion?: string;
  accessScope?: string;
  requestIds?: string[];
  traceIds?: string[];
  stateRefs?: Array<{ source: string; ref: string }>;
}

export class DiagnosticBundleError extends Error {
  public readonly code: string;
  public readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = 'DiagnosticBundleError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * Redact a single string value. Uses deepRedact for pattern-based scrubbing
 * (emails, keys, tokens, XDR, addresses) and maskValue for short opaque
 * identifiers where masking is more appropriate.
 */
function redactString(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  const str = String(value);
  if (str.length === 0) {
    return '';
  }
  const redacted = deepRedact({ value: str }) as { value: unknown };
  const result = redacted && typeof redacted.value === 'string' ? redacted.value : '';
  return result;
}

/**
 * Mask a value that may be a wallet address or opaque identifier. Falls back
 * to redaction when masking is unavailable.
 */
function maskOrRedact(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  const str = String(value);
  if (str.length === 0) {
    return '';
  }
  try {
    const masked = maskValue(str, 'name');
    if (typeof masked === 'string' && masked.length > 0) {
      return masked;
    }
  } catch {
    // fall through to redaction
  }
  return redactString(str);
}

/**
 * Derive a coarse failure category from status and result WITHOUT including
 * the raw result_xdr. Only the category is exported.
 */
export function deriveFailureCategory(
  status: string | null | undefined,
  resultXdr: string | null | undefined,
): DiagnosticFailureCategory {
  const normalizedStatus = (status || '').toLowerCase();
  if (
    normalizedStatus === 'success' ||
    normalizedStatus === 'succeeded' ||
    normalizedStatus === 'confirmed'
  ) {
    return 'none';
  }
  if (
    normalizedStatus === 'pending' ||
    normalizedStatus === 'submitted' ||
    normalizedStatus === 'processing'
  ) {
    return 'pending';
  }
  if (
    normalizedStatus === 'failed' ||
    normalizedStatus === 'error' ||
    normalizedStatus === 'rejected'
  ) {
    // We deliberately do not parse or export result_xdr. We only use its
    // presence to distinguish a rejected submission from an unknown failure.
    if (resultXdr && String(resultXdr).length > 0) {
      return 'rejected';
    }
    return 'unknown';
  }
  return 'unknown';
}

function toIsoString(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toISOString();
}

/**
 * Map a raw transaction row through the allowlist schema. Only allowlisted
 * fields are read; everything else on the row is ignored by construction.
 */
export function mapTransactionRow(row: Record<string, unknown>): DiagnosticBundleTransaction {
  return {
    id: redactString(row.id),
    txHash: redactString(row.tx_hash),
    status: redactString(row.status),
    submittedAt: toIsoString(row.submitted_at),
    updatedAt: toIsoString(row.updated_at),
    transactionType: redactString(row.transaction_type),
    failureCategory: deriveFailureCategory(
      row.status as string | null | undefined,
      row.result_xdr as string | null | undefined,
    ),
  };
}

function mapAuditRow(row: Record<string, unknown>): DiagnosticAuditCorrelation {
  return {
    action: redactString(row.action),
    target: redactString(row.target),
    createdAt: toIsoString(row.created_at),
  };
}

function normalizeIncidentId(incidentId: unknown): string {
  if (typeof incidentId !== 'string') {
    return '';
  }
  const trimmed = incidentId.trim();
  // Incident ids are opaque but bounded; reject anything that could be used
  // to smuggle payloads or path traversal into storage keys.
  if (trimmed.length === 0 || trimmed.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(trimmed)) {
    return '';
  }
  return trimmed;
}

function normalizeActor(actor: unknown): string {
  if (typeof actor !== 'string') {
    return '';
  }
  const trimmed = actor.trim();
  if (trimmed.length === 0 || trimmed.length > 256) {
    return '';
  }
  return trimmed;
}

function dedupeBounded(values: string[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= max) {
      break;
    }
  }
  return out;
}

export class DiagnosticBundleService {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * Generate a diagnostic bundle for a transaction the caller owns.
   * Requires explicit user action (this is only invoked from an authorized
   * endpoint). Returns the persisted bundle id.
   */
  async createDiagnosticBundle(
    transactionId: string,
    publicKey: string,
    options: CreateDiagnosticBundleOptions = {},
  ): Promise<{ bundleId: string; expiresAt: string }> {
    if (!transactionId || !publicKey) {
      throw new DiagnosticBundleError(
        'invalid_request',
        'transactionId and publicKey are required',
        400,
      );
    }

    const ttlMs =
      options.ttlMs && options.ttlMs > 0 ? options.ttlMs : DIAGNOSTIC_BUNDLE_DEFAULT_TTL_MS;
    const appVersion = options.appVersion ? redactString(options.appVersion) : 'unknown';

    // Fetch ONLY allowlisted columns, scoped to the caller's ownership.
    const txResult = await this.pool.query(
      `SELECT id, tx_hash, status, submitted_at, updated_at, transaction_type, result_xdr
         FROM transaction_submissions
        WHERE (id::text = $1 OR tx_hash = $1) AND submitted_by = $2
        LIMIT 1`,
      [transactionId, publicKey],
    );

    if (txResult.rows.length === 0) {
      throw new DiagnosticBundleError('not_found', 'Transaction not found', 404);
    }

    const transaction = mapTransactionRow(txResult.rows[0] as Record<string, unknown>);

    // Optional audit correlation entries, filtered by action/target.
    let auditCorrelation: DiagnosticAuditCorrelation[] = [];
    const auditActions =
      options.auditActions && options.auditActions.length > 0 ? options.auditActions : null;
    try {
      const auditResult = await this.pool.query(
        `SELECT action, target, created_at
           FROM audit_logs
          WHERE target = $1
            AND ($2::text[] IS NULL OR action = ANY($2::text[]))
          ORDER BY created_at ASC
          LIMIT 50`,
        [transactionId, auditActions],
      );
      auditCorrelation = auditResult.rows.map((r) => mapAuditRow(r as Record<string, unknown>));
    } catch {
      // Audit correlation is best-effort; never fail bundle generation on it.
      auditCorrelation = [];
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs);

    const bundle: DiagnosticBundle = {
      bundleId: '', // assigned after insert
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      transaction,
      auditCorrelation,
      appVersion,
    };

    // Final redaction pass over the assembled bundle before serialization.
    const safeBundle = deepRedact(bundle) as DiagnosticBundle;

    const insertResult = await this.pool.query(
      `INSERT INTO diagnostic_bundles (transaction_id, submitted_by, bundle, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [transactionId, publicKey, JSON.stringify(safeBundle), now, expiresAt],
    );

    const bundleId = String(insertResult.rows[0].id);
    safeBundle.bundleId = bundleId;

    // Persist the final bundle id back into the stored bundle.
    await this.pool.query(`UPDATE diagnostic_bundles SET bundle = $1 WHERE id = $2`, [
      JSON.stringify(safeBundle),
      bundleId,
    ]);

    // Log creation WITHOUT bundle contents.
    try {
      await auditLogService.log({
        action: 'diagnostic_bundle.created',
        actor: maskOrRedact(publicKey),
        target: transactionId,
        metadata: { bundleId, expiresAt: expiresAt.toISOString() },
      });
    } catch {
      // Audit logging must not break bundle creation.
    }

    return { bundleId, expiresAt: expiresAt.toISOString() };
  }

  /**
   * Retrieve a diagnostic bundle, enforcing expiry and ownership.
   */
  async getDiagnosticBundle(bundleId: string, publicKey: string): Promise<DiagnosticBundle> {
    if (!bundleId || !publicKey) {
      throw new DiagnosticBundleError(
        'invalid_request',
        'bundleId and publicKey are required',
        400,
      );
    }

    const result = await this.pool.query(
      `SELECT id, transaction_id, submitted_by, bundle, created_at, expires_at
         FROM diagnostic_bundles
        WHERE id = $1 AND submitted_by = $2
        LIMIT 1`,
      [bundleId, publicKey],
    );

    if (result.rows.length === 0) {
      throw new DiagnosticBundleError('not_found', 'Diagnostic bundle not found', 404);
    }

    const row = result.rows[0] as DiagnosticBundleRow;
    const expiresAt = row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
      throw new DiagnosticBundleError('expired', 'Diagnostic bundle has expired', 410);
    }

    const bundle =
      typeof row.bundle === 'string' ? (JSON.parse(row.bundle) as DiagnosticBundle) : row.bundle;
    return deepRedact(bundle) as DiagnosticBundle;
  }

  /**
   * Create (or return the existing) incident evidence bundle for an incident.
   *
   * Idempotent: repeated calls for the same incident id return the existing
   * non-expired bundle rather than creating a new one. All references are
   * bounded and redacted by default; only pointers are stored, never payloads.
   */
  async createBundle(
    incidentId: string,
    actor: string,
    options: CreateIncidentEvidenceBundleOptions = {},
  ): Promise<IncidentEvidenceBundle> {
    const normalizedIncidentId = normalizeIncidentId(incidentId);
    const normalizedActor = normalizeActor(actor);
    if (!normalizedIncidentId || !normalizedActor) {
      throw new DiagnosticBundleError('invalid_request', 'incidentId and actor are required', 400);
    }

    const requestedTtl = options.ttlMs && options.ttlMs > 0 ? options.ttlMs : INCIDENT_EVIDENCE_DEFAULT_TTL_MS;
    const ttlMs = Math.min(requestedTtl, INCIDENT_EVIDENCE_MAX_TTL_MS);
    const accessScope = options.accessScope ? redactString(options.accessScope) : 'incident-responders';
    const appVersion = options.appVersion ? redactString(options.appVersion) : 'unknown';

    // Idempotency: return an existing, non-expired bundle for this incident.
    const existing = await this.pool.query(
      `SELECT incident_id, created_by, access_scope, bundle, created_at, expires_at
         FROM incident_evidence_bundles
        WHERE incident_id = $1
        LIMIT 1`,
      [normalizedIncidentId],
    );
    if (existing.rows.length > 0) {
      const row = existing.rows[0] as IncidentEvidenceBundleRow;
      const expiresAt = row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at);
      if (!Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() > Date.now()) {
        const stored = typeof row.bundle === 'string' ? (JSON.parse(row.bundle) as IncidentEvidenceBundle) : row.bundle;
        return deepRedact(stored) as IncidentEvidenceBundle;
      }
      // Expired: remove so a fresh bundle can be created deterministically.
      await this.pool.query(`DELETE FROM incident_evidence_bundles WHERE incident_id = $1`, [normalizedIncidentId]);
    }

    const now = new Date();
    const capturedAt = now.toISOString();
    const references: IncidentEvidenceReference[] = [];

    const pushRef = (kind: IncidentEvidenceReference['kind'], source: string, ref: unknown) => {
      if (references.length >= INCIDENT_EVIDENCE_MAX_REFERENCES) {
        return;
      }
      const safeRef = redactString(ref);
      if (safeRef.length === 0) {
        return;
      }
      references.push({ kind, source: redactString(source), ref: safeRef, capturedAt });
    };

    // Request and trace references supplied by the caller (bounded + deduped).
    const requestIds = dedupeBounded(options.requestIds || [], INCIDENT_EVIDENCE_MAX_REFERENCES);
    for (const requestId of requestIds) {
      pushRef('request', 'request', requestId);
    }
    const traceIds = dedupeBounded(options.traceIds || [], INCIDENT_EVIDENCE_MAX_REFERENCES);
    for (const traceId of traceIds) {
      pushRef('trace', 'trace', traceId);
    }

    // Ledger checkpoints: bounded, best-effort.
    try {
      const checkpoints = await ledgerCheckpoints.getRecentCheckpoints(INCIDENT_EVIDENCE_MAX_REFERENCES);
      for (const checkpoint of checkpoints || []) {
        pushRef('checkpoint', 'ledger', (checkpoint as { id?: unknown }).id ?? checkpoint);
      }
    } catch {
      // Checkpoint capture is best-effort; never fail bundle creation on it.
    }

    // State references from the authoritative stores/services. Only pointers
    // (ids/keys) are captured, never the underlying state payloads.
    const stateSources: Array<{ source: string; loader: () => Promise<unknown[]> }> = [
      {
        source: 'loan_state_events',
        loader: async () => {
          const events = await loanStateEventStore.getEventsForIncident(normalizedIncidentId);
          return (events || []).map((e: { id?: unknown }) => e.id);
        },
      },
      {
        source: 'remittance',
        loader: async () => {
          const refs = await remittanceService.getIncidentReferences(normalizedIncidentId);
          return refs || [];
        },
      },
      {
        source: 'soroban',
        loader: async () => {
          const refs = await sorobanService.getIncidentReferences(normalizedIncidentId);
          return refs || [];
        },
      },
      {
        source: 'webhook_delivery',
        loader: async () => {
          const refs = await webhookDeliveryService.getIncidentReferences(normalizedIncidentId);
          return refs || [];
        },
      },
    ];

    for (const { source, loader } of stateSources) {
      try {
        const refs = await loader();
        for (const ref of refs || []) {
          pushRef('state', source, ref);
        }
      } catch {
        // Individual state sources are best-effort; a failure in one must not
        // prevent the bundle from capturing the others.
      }
    }

    // Caller-supplied state references (bounded + deduped).
    for (const stateRef of options.stateRefs || []) {
      if (!stateRef || typeof stateRef.ref !== 'string') {
        continue;
      }
      pushRef('state', stateRef.source || 'caller', stateRef.ref);
    }

    const expiresAt = new Date(now.getTime() + ttlMs);

    const bundle: IncidentEvidenceBundle = {
      incidentId: normalizedIncidentId,
      createdAt: capturedAt,
      expiresAt: expiresAt.toISOString(),
      accessScope,
      redactedByDefault: true,
      references,
      appVersion,
    };

    // Final redaction pass over the assembled bundle before serialization.
    const safeBundle = deepRedact(bundle) as IncidentEvidenceBundle;
    const serialized = JSON.stringify(safeBundle);
    if (Buffer.byteLength(serialized, 'utf8') > INCIDENT_EVIDENCE_MAX_BYTES) {
      throw new DiagnosticBundleError(
        'bundle_too_large',
        'Incident evidence bundle exceeds the maximum allowed size',
        413,
      );
    }

    await this.pool.query(
      `INSERT INTO incident_evidence_bundles (incident_id, created_by, access_scope, bundle, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (incident_id) DO NOTHING`,
      [normalizedIncidentId, normalizedActor, accessScope, serialized, now, expiresAt],
    );

    // Log creation WITHOUT bundle contents.
    try {
      await auditLogService.log({
        action: 'incident_evidence_bundle.created',
        actor: maskOrRedact(normalizedActor),
        target: normalizedIncidentId,
        metadata: { accessScope, expiresAt: expiresAt.toISOString(), referenceCount: references.length },
      });
    } catch {
      // Audit logging must not break bundle creation.
    }

    return safeBundle;
  }

  /**
   * Retrieve an incident evidence bundle, enforcing expiry and access scope.
   * Every access is audited.
   */
  async getBundle(incidentId: string, actor: string): Promise<IncidentEvidenceBundle> {
    const normalizedIncidentId = normalizeIncidentId(incidentId);
    const normalizedActor = normalizeActor(actor);
    if (!normalizedIncidentId || !normalizedActor) {
      throw new DiagnosticBundleError('invalid_request', 'incidentId and actor are required', 400);
    }

    const result = await this.pool.query(
      `SELECT incident_id, created_by, access_scope, bundle, created_at, expires_at
         FROM incident_evidence_bundles
        WHERE incident_id = $1
        LIMIT 1`,
      [normalizedIncidentId],
    );

    if (result.rows.length === 0) {
      throw new DiagnosticBundleError('not_found', 'Incident evidence bundle not found', 404);
    }

    const row = result.rows[0] as IncidentEvidenceBundleRow;
    const expiresAt = row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
      throw new DiagnosticBundleError('expired', 'Incident evidence bundle has expired', 410);
    }

    // Access control: the creator always has access; otherwise the actor must
    // be a member of the bundle's declared access scope.
    const isCreator = row.created_by === normalizedActor;
    const isInScope = await this.isActorInAccessScope(normalizedActor, row.access_scope);
    if (!isCreator && !isInScope) {
      try {
        await auditLogService.log({
          action: 'incident_evidence_bundle.access_denied',
          actor: maskOrRedact(normalizedActor),
          target: normalizedIncidentId,
          metadata: { accessScope: row.access_scope },
        });
      } catch {
        // Audit logging must not change the access decision.
      }
      throw new DiagnosticBundleError('forbidden', 'Actor is not authorized for this incident bundle', 403);
    }

    const stored = typeof row.bundle === 'string' ? (JSON.parse(row.bundle) as IncidentEvidenceBundle) : row.bundle;
    const safeBundle = deepRedact(stored) as IncidentEvidenceBundle;

    try {
      await auditLogService.log({
        action: 'incident_evidence_bundle.accessed',
        actor: maskOrRedact(normalizedActor),
        target: normalizedIncidentId,
        metadata: { accessScope: row.access_scope },
      });
    } catch {
      // Audit logging must not break retrieval.
    }

    return safeBundle;
  }

  /**
   * Determine whether an actor belongs to a declared access scope. Scopes are
   * resolved against the audit/role store; unknown scopes deny by default.
   */
  private async isActorInAccessScope(actor: string, accessScope: string): Promise<boolean> {
    if (!accessScope) {
      return false;
    }
    try {
      const result = await this.pool.query(
        `SELECT 1
           FROM actor_access_scopes
          WHERE actor = $1 AND scope = $2
          LIMIT 1`,
        [actor, accessScope],
      );
      return result.rows.length > 0;
    } catch {
      // Fail closed: if scope resolution fails, deny access.
      return false;
    }
  }

  /**
   * Delete a diagnostic bundle owned by the caller.
   */
  async deleteDiagnosticBundle(bundleId: string, publicKey: string): Promise<void> {
    if (!bundleId || !publicKey) {
      throw new DiagnosticBundleError(
        'invalid_request',
        'bundleId and publicKey are required',
        400,
      );
    }

    const result = await this.pool.query(
      `DELETE FROM diagnostic_bundles
        WHERE id = $1 AND submitted_by = $2
        RETURNING id, transaction_id`,
      [bundleId, publicKey],
    );

    if (result.rows.length === 0) {
      throw new DiagnosticBundleError('not_found', 'Diagnostic bundle not found', 404);
    }

    const transactionId = String(result.rows[0].transaction_id);

    // Log deletion WITHOUT bundle contents.
    try {
      await auditLogService.log({
        action: 'diagnostic_bundle.deleted',
        actor: maskOrRedact(publicKey),
        target: transactionId,
        metadata: { bundleId },
      });
    } catch {
      // Audit logging must not break deletion.
    }
  }

  /**
   * Collect every piece of state relevant to a loan into a signed bundle and
   * persist it for LOAN_BUNDLE_TTL_MS. Admin-only: the caller is responsible
   * for authorization.
   */
  async collectLoanBundle(loanId: number, actor: string): Promise<SignedLoanBundle> {
    if (!Number.isInteger(loanId) || loanId <= 0) {
      throw new DiagnosticBundleError('invalid_request', 'loanId must be a positive integer', 400);
    }
    await this.cleanupExpiredBundles();

    const loanRes = await this.pool.query(
      `SELECT * FROM loan_history WHERE loan_id = $1 ORDER BY updated_at DESC LIMIT 1`,
      [loanId],
    );
    if (loanRes.rows.length === 0) {
      throw new DiagnosticBundleError('not_found', 'Loan not found', 404);
    }
    const loan = loanRes.rows[0] as Record<string, unknown>;
    const borrower = String(loan.borrower_public_key ?? '');

    const [events, transactions, notifications, auditLogs, scoreHistory] = await Promise.all([
      this.pool.query(`SELECT * FROM loan_events WHERE loan_id = $1 ORDER BY ledger ASC, id ASC`, [loanId]),
      this.pool.query(
        `SELECT id, tx_hash, status, submitted_at, submitted_by, transaction_type, result_xdr, updated_at
           FROM transaction_submissions WHERE submitted_by = $1 ORDER BY submitted_at ASC`,
        [borrower],
      ),
      this.pool.query(`SELECT * FROM notifications WHERE loan_id = $1 ORDER BY created_at ASC`, [loanId]),
      this.pool.query(
        `SELECT id, actor, action, target, payload, created_at FROM audit_logs
          WHERE target = $1 ORDER BY created_at ASC`,
        [String(loanId)],
      ),
      this.pool.query(
        `SELECT borrower, score, update_reason, updated_at FROM scores WHERE borrower = $1
          ORDER BY updated_at ASC`,
        [borrower],
      ),
    ]);

    const now = new Date();
    const expiresAt = new Date(now.getTime() + LOAN_BUNDLE_TTL_MS);
    const bundle: LoanDiagnosticBundle = {
      bundleId: '',
      loanId,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      loan,
      events: events.rows,
      transactions: transactions.rows,
      notifications: notifications.rows,
      auditLogs: auditLogs.rows,
      scoreHistory: scoreHistory.rows,
    };

    const inserted = await this.pool.query(
      `INSERT INTO diagnostic_bundles (loan_id, submitted_by, bundle, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [loanId, actor, JSON.stringify(bundle), now, expiresAt],
    );
    bundle.bundleId = String(inserted.rows[0].id);
    // The signature covers the final bundle including its id.
    const signature = signBundle(JSON.parse(JSON.stringify(bundle)));
    await this.pool.query(`UPDATE diagnostic_bundles SET bundle = $1, signature = $2 WHERE id = $3`, [
      JSON.stringify(bundle),
      signature,
      bundle.bundleId,
    ]);

    try {
      await auditLogService.log({
        action: 'diagnostic_bundle.loan_collected',
        actor,
        target: String(loanId),
        metadata: { bundleId: bundle.bundleId },
      });
    } catch {
      // best-effort
    }

    return { bundle, signature, algorithm: 'HMAC-SHA256' };
  }

  /**
   * Return what an operator needs to re-submit a transaction via Stellar Laboratory.
   */
  async getReplayData(transactionId: string): Promise<{
    transactionId: string;
    txHash: string;
    status: string;
    transactionType: string;
    envelopeXdr: string;
    submissionParams: Record<string, unknown>;
  }> {
    const res = await this.pool.query(
      `SELECT id, tx_hash, status, transaction_type, envelope_xdr, submission_params, submitted_at, submitted_by
         FROM transaction_submissions WHERE id::text = $1 OR tx_hash = $1 LIMIT 1`,
      [transactionId],
    );
    if (res.rows.length === 0) {
      throw new DiagnosticBundleError('not_found', 'Transaction not found', 404);
    }
    const row = res.rows[0] as Record<string, unknown>;
    if (!row.envelope_xdr) {
      throw new DiagnosticBundleError('no_xdr', 'No envelope XDR was recorded for this transaction', 404);
    }
    return {
      transactionId: String(row.id),
      txHash: String(row.tx_hash),
      status: String(row.status),
      transactionType: String(row.transaction_type),
      envelopeXdr: String(row.envelope_xdr),
      submissionParams: {
        networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE ?? null,
        submittedAt: toIsoString(row.submitted_at),
        submittedBy: row.submitted_by ?? null,
        ...((row.submission_params as Record<string, unknown> | null) ?? {}),
      },
    };
  }

  /** Delete bundles past their TTL. Returns the number removed. */
  async cleanupExpiredBundles(now: Date = new Date()): Promise<number> {
    const res = await this.pool.query(`DELETE FROM diagnostic_bundles WHERE expires_at <= $1`, [now]);
    return res.rowCount ?? 0;
  }
}

export default DiagnosticBundleService;
