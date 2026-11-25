/**
 * Annual threat-model refresh gate for changed trust boundaries (issue #856).
 *
 * Adds two tables:
 *
 *   threat_model_reviews — records each annual review of the threat model for
 *     a named trust boundary (wallet, provider, API, contract). A current
 *     review (within 365 days) is required before the boundary can be changed
 *     in a production release. Reviews include the reviewer, mitigations
 *     addressed, and an approval reference.
 *
 *   trust_boundary_changes — append-only inventory of every change that
 *     touches a named trust boundary. Used by the CI gate to determine whether
 *     a current review exists for the impacted boundary before allowing
 *     production deployment.
 *
 * Both tables are additive; no existing column is modified.
 */
export const shorthands = undefined;

export const up = (pgm) => {
  // ── threat_model_reviews ───────────────────────────────────────────────────
  pgm.createTable('threat_model_reviews', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    // Named trust boundary being reviewed. Must be one of the canonical
    // boundary identifiers: wallet, provider, api, contract, infra.
    boundary: {
      type: 'varchar(64)',
      notNull: true,
    },
    // Reviewer's Stellar public key (G…) or service identity.
    reviewed_by: {
      type: 'varchar(255)',
      notNull: true,
    },
    // A second approver (dual-control). NULL until a second admin approves.
    approved_by: {
      type: 'varchar(255)',
    },
    // Reference to the approval ticket, PR number, or privileged_action_requests.id.
    approval_ref: {
      type: 'varchar(255)',
    },
    // Mitigations addressed in this review cycle.
    // Array of { id: string, description: string, status: 'addressed'|'accepted'|'deferred' }
    mitigations: {
      type: 'jsonb',
      notNull: true,
      default: '[]',
    },
    // Threat-model document hash (SHA-256 of the threat model file content)
    // at the time of review — proves the review covers the current threat model.
    document_hash: {
      type: 'varchar(64)',
      notNull: true,
    },
    // Lifecycle state.
    // 'draft'    — review started but not yet approved by a second admin
    // 'approved' — second admin has approved; counts as a current review
    // 'superseded' — a newer review for the same boundary has been approved
    // 'expired'  — review is older than 365 days (auto-computed, not stored)
    status: {
      type: 'varchar(32)',
      notNull: true,
      default: 'draft',
    },
    // When the reviewed_by admin initiated the review.
    initiated_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('NOW()'),
    },
    // When the second admin approved the review.
    approved_at: {
      type: 'timestamptz',
    },
    // ISO-8601 date of the next required review (initiated_at + 365 days).
    next_review_due: {
      type: 'timestamptz',
      notNull: true,
    },
  });

  pgm.addConstraint('threat_model_reviews', 'threat_model_reviews_status_check', {
    check: `status IN ('draft','approved','superseded')`,
  });

  // Named boundaries this table supports.
  pgm.addConstraint('threat_model_reviews', 'threat_model_reviews_boundary_check', {
    check: `boundary IN ('wallet','provider','api','contract','infra')`,
  });

  // Block self-approval (reviewer and approver must be different).
  pgm.addConstraint('threat_model_reviews', 'threat_model_reviews_no_self_approval', {
    check: `approved_by IS NULL OR approved_by <> reviewed_by`,
  });

  pgm.createIndex('threat_model_reviews', ['boundary', 'status', 'initiated_at'], {
    name: 'idx_tmr_boundary_status_initiated',
  });
  pgm.createIndex('threat_model_reviews', ['status', 'next_review_due'], {
    name: 'idx_tmr_status_due',
  });

  // ── trust_boundary_changes ─────────────────────────────────────────────────
  pgm.createTable('trust_boundary_changes', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    // Which boundary this change touches.
    boundary: {
      type: 'varchar(64)',
      notNull: true,
    },
    // PR number, commit SHA, or deployment ref that introduced the change.
    change_ref: {
      type: 'varchar(255)',
      notNull: true,
    },
    // Brief description of the change.
    description: {
      type: 'text',
      notNull: true,
    },
    // List of changed file paths that triggered the boundary classification.
    changed_files: {
      type: 'jsonb',
      notNull: true,
      default: '[]',
    },
    // The review_id that was current when this change was recorded (may be
    // NULL if no current review existed — i.e. the gate was forced).
    review_id: {
      type: 'uuid',
      references: 'threat_model_reviews',
      onDelete: 'SET NULL',
    },
    // 'gated'   — blocked by lack of current review (CI failed)
    // 'passed'  — current review existed; change allowed
    // 'forced'  — an admin overrode the gate (audit trail only)
    gate_status: {
      type: 'varchar(32)',
      notNull: true,
      default: 'passed',
    },
    // Admin who forced the gate (NULL unless gate_status = 'forced').
    forced_by: {
      type: 'varchar(255)',
    },
    // Reason for forcing the gate.
    force_reason: {
      type: 'text',
    },
    recorded_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('NOW()'),
    },
  });

  pgm.addConstraint('trust_boundary_changes', 'tbc_gate_status_check', {
    check: `gate_status IN ('gated','passed','forced')`,
  });

  pgm.addConstraint('trust_boundary_changes', 'tbc_boundary_check', {
    check: `boundary IN ('wallet','provider','api','contract','infra')`,
  });

  pgm.createIndex('trust_boundary_changes', ['boundary', 'recorded_at'], {
    name: 'idx_tbc_boundary_recorded',
  });
  pgm.createIndex('trust_boundary_changes', ['gate_status', 'recorded_at'], {
    name: 'idx_tbc_gate_status',
  });
  pgm.createIndex('trust_boundary_changes', ['change_ref'], {
    name: 'idx_tbc_change_ref',
  });
};

export const down = (pgm) => {
  pgm.dropTable('trust_boundary_changes', { ifExists: true });
  pgm.dropTable('threat_model_reviews', { ifExists: true });
};
