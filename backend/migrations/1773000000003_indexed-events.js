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
  pgm.createTable('indexed_events', {
    id: 'id',
    event_id: { type: 'varchar(255)', notNull: true, unique: true },
    event_type: { type: 'varchar(50)', notNull: true },
    contract_id: { type: 'varchar(255)', notNull: true },
    tx_hash: { type: 'varchar(255)', notNull: true },
    ledger: { type: 'integer', notNull: true },
    ledger_closed_at: { type: 'timestamp', notNull: true },
    topics: { type: 'jsonb' },
    value: { type: 'text' },
    processed: { type: 'boolean', notNull: true, default: false },
    // Evidence trust taxonomy for scoring inputs (#559).
    // source_type: where the fact originated (on-chain record, indexer event, user claim).
    // verification_status: whether the fact has been verified against an authoritative source.
    // observed_ledger / observed_at: the ledger and time at which the fact was observed.
    // provenance_ref: reference to the authoritative record backing the fact (e.g. tx hash, event id).
    source_type: {
      type: 'varchar(50)',
      notNull: true,
      default: 'indexer_event',
    },
    verification_status: {
      type: 'varchar(50)',
      notNull: true,
      default: 'provisional',
    },
    observed_ledger: { type: 'integer' },
    observed_at: { type: 'timestamp' },
    provenance_ref: { type: 'varchar(255)' },
    // Versioned policy that permitted this evidence to affect the authoritative score, if any.
    policy_version: { type: 'varchar(50)' },
    // Reconciliation bookkeeping so a fact is never double-counted.
    reconciled_at: { type: 'timestamp' },
    invalidated_at: { type: 'timestamp' },
    created_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
    updated_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
  });

  pgm.createIndex('indexed_events', 'event_type');
  pgm.createIndex('indexed_events', 'contract_id');
  pgm.createIndex('indexed_events', 'ledger');
  pgm.createIndex('indexed_events', 'tx_hash');
  pgm.createIndex('indexed_events', 'processed');

  // Contracts boundary: validate the score update reason carried by indexed
  // score events. The reason is persisted inside the event `value` payload as
  // JSON (e.g. {"reason":"repayment"}). Enforce an explicit allow-list at the
  // database boundary so malformed or unknown reasons cannot be persisted,
  // while remaining backward compatible with existing rows (the constraint is
  // NOT VALID and only applies to new/updated rows until validated).
  pgm.addConstraint('indexed_events', 'indexed_events_score_reason_check', {
    check: `(
      event_type <> 'score_updated'
      OR (
        value IS NOT NULL
        AND jsonb_typeof((value::jsonb) -> 'reason') = 'string'
        AND (value::jsonb) ->> 'reason' IN (
          'repayment',
          'late_payment',
          'default',
          'loan_origination',
          'loan_closure',
          'manual_adjustment',
          'migration'
        )
      )
    )`,
    notValid: true,
  });

  // Analytics boundary (#830): bounded, immutable historical contract-state
  // snapshots for audit queries. Each snapshot is anchored to a documented
  // ledger checkpoint and linked to the source event range it was derived
  // from, so reconstruction can be validated against direct contract reads.
  //
  // Compatibility: this is an additive table; existing indexed_events rows
  // and consumers are unaffected. No backfill is required — snapshots are
  // created going forward at documented checkpoints.
  pgm.createTable('contract_state_snapshots', {
    id: 'id',
    // Deterministic identity: one snapshot per (contract, checkpoint).
    contract_id: { type: 'varchar(255)', notNull: true },
    // Documented ledger checkpoint this snapshot represents.
    checkpoint_ledger: { type: 'integer', notNull: true },
    // Source event range the snapshot was reconstructed from (inclusive).
    event_range_start_ledger: { type: 'integer', notNull: true },
    event_range_end_ledger: { type: 'integer', notNull: true },
    event_range_start_event_id: { type: 'varchar(255)' },
    event_range_end_event_id: { type: 'varchar(255)' },
    // Supported snapshot state (e.g. active, closed, defaulted).
    state: { type: 'varchar(50)', notNull: true },
    // Immutable serialized contract state at the checkpoint.
    state_payload: { type: 'jsonb', notNull: true },
    // Validation outcome against direct contract reads.
    validation_status: {
      type: 'varchar(50)',
      notNull: true,
      default: 'pending',
    },
    validated_at: { type: 'timestamp' },
    validation_detail: { type: 'text' },
    // Immutability: snapshots are append-only; created_at is the audit anchor.
    created_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
  });

  // One immutable snapshot per contract checkpoint.
  pgm.addConstraint(
    'contract_state_snapshots',
    'contract_state_snapshots_contract_checkpoint_unique',
    { unique: ['contract_id', 'checkpoint_ledger'] },
  );

  // Input constraints: checkpoint must be within the source event range and
  // the range must be ordered. Reject invalid snapshot requests at the DB
  // boundary so no partial persistence side effects can occur.
  pgm.addConstraint(
    'contract_state_snapshots',
    'contract_state_snapshots_range_check',
    {
      check: `(
        checkpoint_ledger >= 0
        AND event_range_start_ledger >= 0
        AND event_range_end_ledger >= event_range_start_ledger
        AND checkpoint_ledger >= event_range_start_ledger
        AND checkpoint_ledger <= event_range_end_ledger
      )`,
    },
  );

  // Supported snapshot states and validation outcomes.
  pgm.addConstraint(
    'contract_state_snapshots',
    'contract_state_snapshots_state_check',
    {
      check: `state IN ('active', 'closed', 'defaulted', 'liquidated')`,
    },
  );

  pgm.addConstraint(
    'contract_state_snapshots',
    'contract_state_snapshots_validation_status_check',
    {
      check: `validation_status IN ('pending', 'validated', 'mismatch', 'failed')`,
    },
  );

  pgm.createIndex('contract_state_snapshots', 'contract_id');
  pgm.createIndex('contract_state_snapshots', 'checkpoint_ledger');
  pgm.createIndex('contract_state_snapshots', 'validation_status');
  pgm.createIndex('contract_state_snapshots', [
    'contract_id',
    'checkpoint_ledger',
  ]);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @param run {() => void | undefined}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
  pgm.dropTable('contract_state_snapshots');
  pgm.dropConstraint('indexed_events', 'indexed_events_score_reason_check', {
    ifExists: true,
  });
  pgm.dropTable('indexed_events');
};
