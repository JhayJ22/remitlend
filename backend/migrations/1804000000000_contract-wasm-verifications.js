/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.createTable('contract_verifications', {
    id: 'id',
    contract_id: { type: 'varchar(56)', notNull: true },
    contract_name: { type: 'varchar(128)', notNull: true },
    expected_wasm_hash: { type: 'varchar(64)' },
    actual_wasm_hash: { type: 'varchar(64)' },
    status: {
      type: 'varchar(32)',
      notNull: true,
      check: "status IN ('match', 'mismatch', 'error', 'missing_expected_hash')",
    },
    error: { type: 'text' },
    checked_at: { type: 'timestamp', notNull: true, default: pgm.func('current_timestamp') },
  });
  pgm.createIndex('contract_verifications', ['contract_id', 'checked_at']);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropTable('contract_verifications');
};
