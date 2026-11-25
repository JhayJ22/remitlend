/**
 * Threat-Model Refresh Gate Service (issue #856)
 *
 * Automates a change inventory for wallet, provider, API, and contract trust
 * boundaries; enforces that a reviewed threat-model update (approved by two
 * admins, within the last 365 days) exists before a production release that
 * touches a named boundary.
 *
 * Design guarantees:
 *  - A "current review" is defined as: status='approved' AND approved_at >
 *    NOW() - INTERVAL '365 days'. Only one review is current per boundary at
 *    any time (older approved reviews are superseded automatically).
 *  - Self-approval is blocked by a DB CHECK constraint and enforced here.
 *  - Gate override (force) is append-only and audited; it never modifies the
 *    review state.
 *  - Idempotent: recording the same change_ref + boundary twice is a no-op
 *    (upsert on conflict).
 */

import crypto from 'node:crypto';
import { pool } from '../db/connection.js';
import logger from '../utils/logger.js';
import { AppError } from '../errors/AppError.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type TrustBoundary = 'wallet' | 'provider' | 'api' | 'contract' | 'infra';
export const TRUST_BOUNDARIES: readonly TrustBoundary[] = [
  'wallet', 'provider', 'api', 'contract', 'infra',
] as const;

export type ReviewStatus = 'draft' | 'approved' | 'superseded';
export type GateStatus = 'gated' | 'passed' | 'forced';

export interface Mitigation {
  id: string;
  description: string;
  status: 'addressed' | 'accepted' | 'deferred';
}

export interface ThreatModelReview {
  id: string;
  boundary: TrustBoundary;
  reviewed_by: string;
  approved_by: string | null;
  approval_ref: string | null;
  mitigations: Mitigation[];
  document_hash: string;
  status: ReviewStatus;
  initiated_at: Date;
  approved_at: Date | null;
  next_review_due: Date;
}

export interface TrustBoundaryChange {
  id: string;
  boundary: TrustBoundary;
  change_ref: string;
  description: string;
  changed_files: string[];
  review_id: string | null;
  gate_status: GateStatus;
  forced_by: string | null;
  force_reason: string | null;
  recorded_at: Date;
}

export interface InitiateReviewOptions {
  boundary: TrustBoundary;
  reviewedBy: string;
  documentHash: string;
  mitigations?: Mitigation[];
  approvalRef?: string | null;
}

export interface ApproveReviewOptions {
  reviewId: string;
  approvedBy: string;
  approvalRef?: string;
}

export interface RecordBoundaryChangeOptions {
  boundary: TrustBoundary;
  changeRef: string;
  description: string;
  changedFiles: string[];
  /** If true, records as 'forced' even without a current review. Requires forceBy + forceReason. */
  force?: boolean;
  forcedBy?: string;
  forceReason?: string;
}

export interface GateCheckResult {
  boundary: TrustBoundary;
  passed: boolean;
  review: ThreatModelReview | null;
  reason: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Maximum age of an approved review for it to count as "current". */
export const REVIEW_TTL_DAYS = 365;

/**
 * File path patterns that indicate a trust boundary is being changed.
 * Keys are boundary names; values are prefix/substring patterns.
 */
export const BOUNDARY_FILE_PATTERNS: Record<TrustBoundary, string[]> = {
  wallet: [
    'backend/src/services/authService',
    'backend/src/middleware/jwtAuth',
    'backend/src/services/challengeNonceService',
    'frontend/src/lib/wallet',
    'frontend/src/hooks/useWallet',
  ],
  provider: [
    'backend/src/services/soroban',
    'backend/src/config/stellar',
    'backend/src/services/piiCrypto',
    'backend/src/services/keyRotation',
    'backend/src/services/backupService',
  ],
  api: [
    'backend/src/routes/',
    'backend/src/middleware/auth',
    'backend/src/middleware/rateLimiter',
    'backend/src/schemas/',
  ],
  contract: [
    'contracts/',
    'backend/src/services/sorobanService',
    'backend/src/services/contractVerification',
    'scripts/deploy',
  ],
  infra: [
    'docker-compose',
    '.github/workflows/',
    'backend/src/db/',
    'backend/migrations/',
    'backend/src/config/',
  ],
};

// ── Service ───────────────────────────────────────────────────────────────────

class ThreatModelRefreshService {
  /**
   * Classify changed file paths against the boundary pattern map.
   * Returns a de-duplicated list of boundaries touched by the given file list.
   */
  classifyChangedFiles(files: string[]): TrustBoundary[] {
    const touched = new Set<TrustBoundary>();
    for (const file of files) {
      for (const [boundary, patterns] of Object.entries(BOUNDARY_FILE_PATTERNS)) {
        if (patterns.some((p) => file.includes(p))) {
          touched.add(boundary as TrustBoundary);
        }
      }
    }
    return [...touched];
  }

  /**
   * Compute a SHA-256 hash of a threat-model document's content.
   * Used to prove the reviewer reviewed the current version.
   */
  hashDocument(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
  }

  /**
   * Check whether a named boundary has a current approved review
   * (approved within the last REVIEW_TTL_DAYS days).
   */
  async getCurrentReview(boundary: TrustBoundary): Promise<ThreatModelReview | null> {
    const result = await pool.query(
      `SELECT * FROM threat_model_reviews
       WHERE boundary = $1
         AND status = 'approved'
         AND approved_at > NOW() - INTERVAL '${REVIEW_TTL_DAYS} days'
       ORDER BY approved_at DESC
       LIMIT 1`,
      [boundary],
    );
    return result.rows.length > 0 ? (result.rows[0] as ThreatModelReview) : null;
  }

  /**
   * Run the gate check for a list of boundaries.
   * Returns a result per boundary — the caller determines whether to fail.
   */
  async checkGate(boundaries: TrustBoundary[]): Promise<GateCheckResult[]> {
    const results: GateCheckResult[] = [];
    for (const boundary of boundaries) {
      const review = await this.getCurrentReview(boundary);
      if (review) {
        results.push({
          boundary,
          passed: true,
          review,
          reason: `Current approved review exists (id: ${review.id}, approved: ${review.approved_at?.toISOString()})`,
        });
      } else {
        results.push({
          boundary,
          passed: false,
          review: null,
          reason: `No approved threat-model review for boundary '${boundary}' within the last ${REVIEW_TTL_DAYS} days`,
        });
      }
    }
    return results;
  }

  /**
   * Initiate a new threat-model review (draft state).
   * A second admin must call approveReview() before it counts as current.
   */
  async initiateReview(opts: InitiateReviewOptions): Promise<ThreatModelReview> {
    const { boundary, reviewedBy, documentHash, mitigations = [], approvalRef = null } = opts;

    if (!TRUST_BOUNDARIES.includes(boundary)) {
      throw AppError.badRequest(`Unknown boundary '${boundary}'. Valid: ${TRUST_BOUNDARIES.join(', ')}`);
    }

    // One draft per boundary per reviewer at a time.
    const existing = await pool.query(
      `SELECT id FROM threat_model_reviews
       WHERE boundary = $1 AND reviewed_by = $2 AND status = 'draft'
       LIMIT 1`,
      [boundary, reviewedBy],
    );
    if (existing.rows.length > 0) {
      const row = existing.rows[0] as { id: string };
      throw AppError.conflict(
        `A draft review already exists for boundary '${boundary}' by this reviewer (id: ${row.id}). ` +
          `Complete or cancel it before starting a new one.`,
      );
    }

    const nextDue = new Date();
    nextDue.setDate(nextDue.getDate() + REVIEW_TTL_DAYS);

    const result = await pool.query(
      `INSERT INTO threat_model_reviews
         (boundary, reviewed_by, approval_ref, mitigations, document_hash, next_review_due)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6)
       RETURNING *`,
      [boundary, reviewedBy, approvalRef, JSON.stringify(mitigations), documentHash, nextDue.toISOString()],
    );

    const row = result.rows[0] as ThreatModelReview;

    await this.writeAudit(reviewedBy, 'THREAT_MODEL_REVIEW_INITIATED', `boundary:${boundary}`, {
      review_id: row.id,
      document_hash: documentHash,
    });

    logger.info('threat_model_review_initiated', {
      review_id: row.id,
      boundary,
      reviewed_by: reviewedBy,
    });

    return row;
  }

  /**
   * Approve a draft review (second-admin approval).
   * Automatically supersedes any older approved reviews for the same boundary.
   */
  async approveReview(opts: ApproveReviewOptions): Promise<ThreatModelReview> {
    const { reviewId, approvedBy, approvalRef } = opts;

    // Load the draft.
    const draft = await pool.query(
      `SELECT * FROM threat_model_reviews WHERE id = $1`,
      [reviewId],
    );
    if (draft.rows.length === 0) {
      throw AppError.notFound(`Threat-model review ${reviewId} not found`);
    }
    const review = draft.rows[0] as ThreatModelReview;

    if (review.status !== 'draft') {
      throw AppError.conflict(`Review ${reviewId} is already in state '${review.status}'`);
    }
    if (review.reviewed_by === approvedBy) {
      throw AppError.forbidden('The reviewer cannot approve their own threat-model review (self-approval blocked)');
    }

    // Approve this review.
    const updated = await pool.query(
      `UPDATE threat_model_reviews
       SET status = 'approved',
           approved_by = $2,
           approved_at = NOW(),
           approval_ref = COALESCE($3, approval_ref)
       WHERE id = $1
       RETURNING *`,
      [reviewId, approvedBy, approvalRef ?? null],
    );
    const approved = updated.rows[0] as ThreatModelReview;

    // Supersede older approved reviews for the same boundary.
    await pool.query(
      `UPDATE threat_model_reviews
       SET status = 'superseded'
       WHERE boundary = $1
         AND status = 'approved'
         AND id <> $2`,
      [review.boundary, reviewId],
    );

    await this.writeAudit(approvedBy, 'THREAT_MODEL_REVIEW_APPROVED', `boundary:${review.boundary}`, {
      review_id: reviewId,
      approved_by: approvedBy,
    });

    logger.info('threat_model_review_approved', {
      review_id: reviewId,
      boundary: review.boundary,
      approved_by: approvedBy,
    });

    return approved;
  }

  /**
   * Record a trust-boundary change from CI or the admin API.
   *
   * Checks whether a current review exists; sets gate_status accordingly.
   * Idempotent: same change_ref + boundary is an upsert.
   */
  async recordBoundaryChange(opts: RecordBoundaryChangeOptions): Promise<TrustBoundaryChange> {
    const { boundary, changeRef, description, changedFiles, force = false, forcedBy, forceReason } = opts;

    if (!TRUST_BOUNDARIES.includes(boundary)) {
      throw AppError.badRequest(`Unknown boundary '${boundary}'`);
    }

    if (force && (!forcedBy || !forceReason)) {
      throw AppError.badRequest('forcedBy and forceReason are required when force=true');
    }

    let gateStatus: GateStatus;
    let reviewId: string | null = null;

    if (force) {
      gateStatus = 'forced';
    } else {
      const current = await this.getCurrentReview(boundary);
      if (current) {
        gateStatus = 'passed';
        reviewId = current.id;
      } else {
        gateStatus = 'gated';
      }
    }

    const result = await pool.query(
      `INSERT INTO trust_boundary_changes
         (boundary, change_ref, description, changed_files, review_id,
          gate_status, forced_by, force_reason)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [
        boundary,
        changeRef,
        description,
        JSON.stringify(changedFiles),
        reviewId,
        gateStatus,
        forcedBy ?? null,
        forceReason ?? null,
      ],
    );

    // If the row already existed, fetch it.
    const row: TrustBoundaryChange = result.rows.length > 0
      ? (result.rows[0] as TrustBoundaryChange)
      : (await pool.query(
          `SELECT * FROM trust_boundary_changes WHERE boundary = $1 AND change_ref = $2 LIMIT 1`,
          [boundary, changeRef],
        ).then((r) => r.rows[0] as TrustBoundaryChange));

    logger.info('trust_boundary_change_recorded', {
      id: row.id,
      boundary,
      change_ref: changeRef,
      gate_status: gateStatus,
    });

    if (gateStatus === 'gated') {
      logger.warn('trust_boundary_change_gated', {
        boundary,
        change_ref: changeRef,
        reason: `No current threat-model review for boundary '${boundary}'`,
      });
    }

    if (gateStatus === 'forced') {
      logger.warn('trust_boundary_change_forced', {
        boundary,
        change_ref: changeRef,
        forced_by: forcedBy,
        force_reason: forceReason,
      });
      await this.writeAudit(
        forcedBy!,
        'THREAT_MODEL_GATE_FORCED',
        `boundary:${boundary}`,
        { change_ref: changeRef, force_reason: forceReason },
      );
    }

    return row;
  }

  /**
   * Generate a full change inventory for a set of file paths.
   * Returns the boundary classification and gate check for each boundary
   * that is touched by the files.
   */
  async generateChangeInventory(opts: {
    files: string[];
    changeRef: string;
  }): Promise<{
    touchedBoundaries: TrustBoundary[];
    gateResults: GateCheckResult[];
    allPassed: boolean;
  }> {
    const touchedBoundaries = this.classifyChangedFiles(opts.files);
    const gateResults = await this.checkGate(touchedBoundaries);
    const allPassed = gateResults.every((r) => r.passed);
    return { touchedBoundaries, gateResults, allPassed };
  }

  // ── Query helpers ──────────────────────────────────────────────────────────

  async getReview(reviewId: string): Promise<ThreatModelReview> {
    const r = await pool.query(`SELECT * FROM threat_model_reviews WHERE id = $1`, [reviewId]);
    if (r.rows.length === 0) throw AppError.notFound(`Threat-model review ${reviewId} not found`);
    return r.rows[0] as ThreatModelReview;
  }

  async listReviews(opts: {
    boundary?: TrustBoundary;
    status?: ReviewStatus;
    limit?: number;
    cursor?: string;
  }): Promise<{ data: ThreatModelReview[]; nextCursor: string | null }> {
    const { boundary, status, limit = 50, cursor } = opts;
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (boundary) { conditions.push(`boundary = $${values.length + 1}`); values.push(boundary); }
    if (status) { conditions.push(`status = $${values.length + 1}`); values.push(status); }
    if (cursor) { conditions.push(`id < $${values.length + 1}`); values.push(cursor); }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    values.push(limit + 1);
    const r = await pool.query(
      `SELECT * FROM threat_model_reviews ${where} ORDER BY initiated_at DESC LIMIT $${values.length}`,
      values,
    );
    const rows = r.rows as ThreatModelReview[];
    const hasNext = rows.length > limit;
    return { data: rows.slice(0, limit), nextCursor: hasNext ? rows[limit - 1]!.id : null };
  }

  async listChanges(opts: {
    boundary?: TrustBoundary;
    gateStatus?: GateStatus;
    limit?: number;
  }): Promise<TrustBoundaryChange[]> {
    const { boundary, gateStatus, limit = 50 } = opts;
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (boundary) { conditions.push(`boundary = $${values.length + 1}`); values.push(boundary); }
    if (gateStatus) { conditions.push(`gate_status = $${values.length + 1}`); values.push(gateStatus); }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    values.push(limit);
    const r = await pool.query(
      `SELECT * FROM trust_boundary_changes ${where} ORDER BY recorded_at DESC LIMIT $${values.length}`,
      values,
    );
    return r.rows as TrustBoundaryChange[];
  }

  // ── Audit helper ───────────────────────────────────────────────────────────

  private async writeAudit(
    actor: string,
    action: string,
    target: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await pool.query(
        `INSERT INTO audit_logs (actor, action, target, payload, status)
         VALUES ($1, $2, $3, $4::jsonb, 200)`,
        [actor, action, target, JSON.stringify(payload)],
      );
    } catch (err) {
      logger.error('threat_model_audit_log_failed', {
        action,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export const threatModelRefreshService = new ThreatModelRefreshService();
