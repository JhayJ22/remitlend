/**
 * Diagnostic bundles (#786), replay XDR capture and analytics indexes (#788).
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.createTable(
    'diagnostic_bundles',
    {
      id: 'id',
      transaction_id: { type: 'varchar(255)' },
      loan_id: { type: 'integer' },
      submitted_by: { type: 'varchar(255)', notNull: true },
      bundle: { type: 'jsonb', notNull: true },
      signature: { type: 'varchar(128)' },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
      expires_at: { type: 'timestamptz', notNull: true },
    },
    { ifNotExists: true },
  );
  pgm.createIndex('diagnostic_bundles', ['expires_at'], { ifNotExists: true });
  pgm.createIndex('diagnostic_bundles', ['loan_id'], { ifNotExists: true });

  // Raw signed envelope kept so operators can re-submit via Stellar Laboratory.
  pgm.sql('ALTER TABLE transaction_submissions ADD COLUMN IF NOT EXISTS envelope_xdr text');
  pgm.sql('ALTER TABLE transaction_submissions ADD COLUMN IF NOT EXISTS submission_params jsonb');

  // Indexed aggregation support for GET /analytics/protocol-stats.
  pgm.sql('CREATE INDEX IF NOT EXISTS idx_loan_history_created_at ON loan_history (created_at)');
  pgm.sql('CREATE INDEX IF NOT EXISTS idx_loan_history_status ON loan_history (status)');
  pgm.sql(
    'CREATE INDEX IF NOT EXISTS idx_remittances_sender_created ON remittances (sender_id, created_at DESC)',
  );
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.sql('DROP INDEX IF EXISTS idx_remittances_sender_created');
  pgm.sql('DROP INDEX IF EXISTS idx_loan_history_status');
  pgm.sql('DROP INDEX IF EXISTS idx_loan_history_created_at');
  pgm.sql('ALTER TABLE transaction_submissions DROP COLUMN IF EXISTS submission_params');
  pgm.sql('ALTER TABLE transaction_submissions DROP COLUMN IF EXISTS envelope_xdr');
  pgm.dropTable('diagnostic_bundles', { ifExists: true });
};
