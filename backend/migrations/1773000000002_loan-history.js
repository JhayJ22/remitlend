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
  pgm.createTable('loan_history', {
    id: 'id',
    loan_id: { type: 'integer', notNull: true },
    borrower_public_key: { type: 'varchar(255)', notNull: true },
    lender_public_key: { type: 'varchar(255)' },
    principal_amount: { type: 'numeric', notNull: true },
    interest_rate_bps: { type: 'integer', notNull: true },
    principal_paid: { type: 'numeric', default: 0 },
    interest_paid: { type: 'numeric', default: 0 },
    accrued_interest: { type: 'numeric', default: 0 },
    status: { type: 'varchar(50)', notNull: true },
    due_date: { type: 'timestamp' },
    requested_at: { type: 'timestamp' },
    approved_at: { type: 'timestamp' },
    repaid_at: { type: 'timestamp' },
    defaulted_at: { type: 'timestamp' },
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
    metadata: { type: 'jsonb' },
  });

  pgm.createIndex('loan_history', 'loan_id');
  pgm.createIndex('loan_history', 'borrower_public_key');
  pgm.createIndex('loan_history', 'lender_public_key');
  pgm.createIndex('loan_history', 'status');

  // Bounded score-history pagination: deterministic keyset ordering on
  // (created_at, id) so cursors are stable and page reads stay index-backed.
  // Additive only — no schema-breaking changes to persisted data.
  pgm.createIndex('loan_history', ['created_at', 'id'], {
    name: 'loan_history_created_at_id_idx',
  });
  pgm.createIndex('loan_history', ['borrower_public_key', 'created_at', 'id'], {
    name: 'loan_history_borrower_created_at_id_idx',
  });
  pgm.createIndex('loan_history', ['lender_public_key', 'created_at', 'id'], {
    name: 'loan_history_lender_created_at_id_idx',
  });

  // Historical contract-state snapshots for audit queries (#830).
  // Immutable, bounded snapshots captured at documented ledger checkpoints.
  // Each snapshot is linked to the source event range it was reconstructed
  // from and records the outcome of validating that reconstruction against a
  // direct contract read. Additive only — no changes to existing tables.
  pgm.createTable('contract_state_snapshots', {
    id: 'id',
    contract_id: { type: 'varchar(255)', notNull: true },
    // Documented ledger checkpoint the snapshot represents.
    checkpoint_ledger: { type: 'bigint', notNull: true },
    // Source event range the snapshot was reconstructed from (inclusive).
    event_range_start_ledger: { type: 'bigint', notNull: true },
    event_range_end_ledger: { type: 'bigint', notNull: true },
    event_range_start_id: { type: 'bigint' },
    event_range_end_id: { type: 'bigint' },
    // Immutable serialized contract state at the checkpoint.
    state: { type: 'jsonb', notNull: true },
    // Deterministic digest of `state` for tamper-evident audit queries.
    state_hash: { type: 'varchar(128)', notNull: true },
    // Outcome of validating reconstruction against a direct contract read.
    validation_status: {
      type: 'varchar(20)',
      notNull: true,
      default: 'pending',
      check: "validation_status IN ('pending', 'valid', 'mismatch', 'failed')",
    },
    validation_details: { type: 'jsonb' },
    validated_at: { type: 'timestamp' },
    created_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
  });

  // One immutable snapshot per (contract, checkpoint): rejects duplicate or
  // stale snapshot writes without partial persistence side effects.
  pgm.addConstraint('contract_state_snapshots', 'contract_state_snapshots_contract_checkpoint_key', {
    unique: ['contract_id', 'checkpoint_ledger'],
  });
  pgm.addConstraint('contract_state_snapshots', 'contract_state_snapshots_event_range_check', {
    check: 'event_range_start_ledger <= event_range_end_ledger AND event_range_end_ledger <= checkpoint_ledger',
  });

  pgm.createIndex('contract_state_snapshots', ['contract_id', 'checkpoint_ledger'], {
    name: 'contract_state_snapshots_contract_checkpoint_idx',
  });
  pgm.createIndex('contract_state_snapshots', ['contract_id', 'validation_status'], {
    name: 'contract_state_snapshots_contract_validation_idx',
  });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @param run {() => void | undefined}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
  pgm.dropIndex('contract_state_snapshots', ['contract_id', 'validation_status'], {
    name: 'contract_state_snapshots_contract_validation_idx',
  });
  pgm.dropIndex('contract_state_snapshots', ['contract_id', 'checkpoint_ledger'], {
    name: 'contract_state_snapshots_contract_checkpoint_idx',
  });
  pgm.dropTable('contract_state_snapshots');

  pgm.dropIndex('loan_history', ['lender_public_key', 'created_at', 'id'], {
    name: 'loan_history_lender_created_at_id_idx',
  });
  pgm.dropIndex('loan_history', ['borrower_public_key', 'created_at', 'id'], {
    name: 'loan_history_borrower_created_at_id_idx',
  });
  pgm.dropIndex('loan_history', ['created_at', 'id'], {
    name: 'loan_history_created_at_id_idx',
  });
  pgm.dropTable('loan_history');
};
