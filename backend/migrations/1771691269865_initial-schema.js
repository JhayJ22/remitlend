/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @param run {() => void | undefined}
 * @returns {Promise<void> | void}
 */
export const up = (pgm) => {
  pgm.createTable('scores', {
    id: 'id',
    user_id: { type: 'varchar(255)', notNull: true, unique: true },
    current_score: { type: 'integer', notNull: true, default: 500 },
    updated_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
  });

  // Score update reason schema validation: constrain the reason values that
  // may be persisted for a score update so downstream contracts and API
  // consumers can rely on a bounded, authoritative set of reasons.
  pgm.addColumn('scores', {
    update_reason: {
      type: 'varchar(50)',
      notNull: true,
      default: 'initial',
    },
  });

  pgm.addConstraint('scores', 'scores_update_reason_check', {
    check:
      "update_reason IN ('initial', 'remittance', 'loan_repayment', 'loan_default', 'manual_adjustment', 'migration')",
  });

  pgm.createTable('remittance_history', {
    id: 'id',
    user_id: { type: 'varchar(255)', notNull: true },
    amount: { type: 'numeric', notNull: true },
    month: { type: 'varchar(50)', notNull: true },
    status: { type: 'varchar(50)', notNull: true },
    created_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
  });

  pgm.createIndex('remittance_history', 'user_id');

  // Model versions: each approved model version carries the parameter snapshot
  // used at approval time. Existing loans reference the version they were
  // originated under so rollback never alters existing loan obligations.
  pgm.createTable('model_versions', {
    id: 'id',
    version: { type: 'varchar(50)', notNull: true, unique: true },
    status: { type: 'varchar(20)', notNull: true, default: 'approved' },
    parameters: { type: 'jsonb', notNull: true },
    approved_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
  });

  // Origination-time parameter snapshot per loan. Immutable once written so
  // rollback of new originations cannot change existing loan obligations.
  pgm.createTable('loan_origination_snapshots', {
    id: 'id',
    loan_id: { type: 'varchar(255)', notNull: true, unique: true },
    model_version_id: {
      type: 'integer',
      notNull: true,
      references: 'model_versions',
    },
    parameters: { type: 'jsonb', notNull: true },
    originated_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
  });

  pgm.createIndex('loan_origination_snapshots', 'model_version_id');

  // Aggregate, bounded-cardinality monitoring metrics. No borrower-level
  // scores or identifiers are stored here: only cohort-level buckets.
  pgm.createTable('model_monitoring_metrics', {
    id: 'id',
    model_version_id: {
      type: 'integer',
      notNull: true,
      references: 'model_versions',
    },
    metric: { type: 'varchar(50)', notNull: true },
    cohort: { type: 'varchar(50)', notNull: true },
    bucket: { type: 'varchar(50)', notNull: true },
    value: { type: 'numeric', notNull: true },
    sample_size: { type: 'integer', notNull: true },
    completeness: { type: 'numeric', notNull: true },
    window_start: { type: 'timestamp', notNull: true },
    window_end: { type: 'timestamp', notNull: true },
    created_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
  });

  pgm.createIndex('model_monitoring_metrics', [
    'model_version_id',
    'metric',
    'window_end',
  ]);

  // Alert thresholds that trigger review or rollback of new originations to
  // the last approved model version. Includes sample-size and completeness
  // guardrails so sparse or incomplete cohorts do not trigger reactions.
  pgm.createTable('model_monitoring_thresholds', {
    id: 'id',
    metric: { type: 'varchar(50)', notNull: true, unique: true },
    warn_threshold: { type: 'numeric', notNull: true },
    rollback_threshold: { type: 'numeric', notNull: true },
    min_sample_size: { type: 'integer', notNull: true, default: 100 },
    min_completeness: { type: 'numeric', notNull: true, default: 0.9 },
    action: { type: 'varchar(20)', notNull: true, default: 'review' },
    updated_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
  });

  // Governed data-access requests for analysts. Each request must state a
  // purpose, select a minimal dataset, carry a bounded expiry, and name an
  // approver distinct from the requester. State transitions are constrained
  // so invalid or stale actions are rejected at the persistence boundary.
  pgm.createTable('data_access_requests', {
    id: 'id',
    requester_id: { type: 'varchar(255)', notNull: true },
    approver_id: { type: 'varchar(255)', notNull: true },
    purpose: { type: 'varchar(500)', notNull: true },
    dataset: { type: 'varchar(100)', notNull: true },
    status: { type: 'varchar(20)', notNull: true, default: 'requested' },
    requested_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
    expires_at: { type: 'timestamp', notNull: true },
    decided_at: { type: 'timestamp' },
    revoked_at: { type: 'timestamp' },
  });

  pgm.addConstraint('data_access_requests', 'data_access_requests_status_check', {
    check:
      "status IN ('requested', 'approved', 'granted', 'denied', 'revoked', 'expired')",
  });

  // Requester cannot self-approve: approver must be a distinct actor.
  pgm.addConstraint('data_access_requests', 'data_access_requests_distinct_approver_check', {
    check: 'requester_id <> approver_id',
  });

  // Mandatory stated purpose and minimal dataset selection.
  pgm.addConstraint('data_access_requests', 'data_access_requests_purpose_check', {
    check: "length(btrim(purpose)) > 0",
  });

  pgm.addConstraint('data_access_requests', 'data_access_requests_dataset_check', {
    check: "length(btrim(dataset)) > 0",
  });

  // Bounded expiry: must be after the request was made.
  pgm.addConstraint('data_access_requests', 'data_access_requests_expiry_check', {
    check: 'expires_at > requested_at',
  });

  pgm.createIndex('data_access_requests', ['status', 'expires_at']);
  pgm.createIndex('data_access_requests', 'requester_id');

  // Append-only audit log of every grant and revocation with actor, reason,
  // and dataset scope. Never updated or deleted so the trail is authoritative.
  pgm.createTable('data_access_audit_log', {
    id: 'id',
    request_id: {
      type: 'integer',
      notNull: true,
      references: 'data_access_requests',
    },
    action: { type: 'varchar(20)', notNull: true },
    actor_id: { type: 'varchar(255)', notNull: true },
    dataset: { type: 'varchar(100)', notNull: true },
    reason: { type: 'varchar(500)' },
    created_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
  });

  pgm.addConstraint('data_access_audit_log', 'data_access_audit_log_action_check', {
    check: "action IN ('granted', 'revoked', 'expired')",
  });

  pgm.createIndex('data_access_audit_log', ['request_id', 'created_at']);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @param run {() => void | undefined}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
  pgm.dropTable('data_access_audit_log');
  pgm.dropTable('data_access_requests');
  pgm.dropTable('model_monitoring_thresholds');
  pgm.dropTable('model_monitoring_metrics');
  pgm.dropTable('loan_origination_snapshots');
  pgm.dropTable('model_versions');
  pgm.dropTable('remittance_history');
  pgm.dropTable('scores');
};
