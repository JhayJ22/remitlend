export const shorthands = undefined;

export const up = (pgm) => {
  pgm.createTable('statement_manifest_issuances', {
    id: 'id',
    manifest_id: { type: 'char(64)', notNull: true, unique: true },
    key_id: { type: 'varchar(128)', notNull: true },
    source_type: { type: 'varchar(32)', notNull: true },
    schema_version: { type: 'varchar(64)', notNull: true },
    subject_hash: { type: 'char(64)', notNull: true },
    row_count: { type: 'integer', notNull: true },
    issued_at: { type: 'timestamptz', notNull: true },
    manifest_json: { type: 'text', notNull: true },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('CURRENT_TIMESTAMP'),
    },
  });

  pgm.addConstraint('statement_manifest_issuances', 'statement_manifest_issuances_source_check', {
    check: "source_type IN ('activity', 'wallet_payments', 'loan_events')",
  });

  pgm.addConstraint('statement_manifest_issuances', 'statement_manifest_issuances_rows_check', {
    check: 'row_count >= 0 AND row_count <= 100000',
  });

  pgm.addConstraint('statement_manifest_issuances', 'statement_manifest_issuances_hash_check', {
    check: "manifest_id ~ '^[a-f0-9]{64}$' AND subject_hash ~ '^[a-f0-9]{64}$'",
  });

  pgm.createIndex('statement_manifest_issuances', 'issued_at');
  pgm.createIndex('statement_manifest_issuances', ['key_id', 'issued_at']);
};

export const down = (pgm) => {
  pgm.dropTable('statement_manifest_issuances');
};
