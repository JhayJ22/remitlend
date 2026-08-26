/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  // Table to track contract verification status
  pgm.createTable('contract_verification', {
    id: 'id',
    contract_id: {
      type: 'string',
      notNull: true,
      unique: true,
    },
    contract_name: {
      type: 'string',
      notNull: true,
    },
    source_code_hash: {
      type: 'string',
      notNull: true,
      comment: 'SHA256 hash of source code for integrity verification',
    },
    wasm_hash: {
      type: 'string',
      notNull: true,
      comment: 'SHA256 hash of compiled WASM binary',
    },
    verified: {
      type: 'boolean',
      notNull: true,
      default: false,
    },
    verified_at: {
      type: 'timestamp',
      comment: 'Timestamp when verification was confirmed',
    },
    verification_attempted_at: {
      type: 'timestamp',
      comment: 'Timestamp of last verification attempt',
    },
    created_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('NOW()'),
    },
    updated_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('NOW()'),
    },
  });

  // Index for querying unverified contracts
  pgm.createIndex('contract_verification', 'verified');
  // Index for querying by contract ID
  pgm.createIndex('contract_verification', 'contract_id');

  // Table to audit all verification attempts
  pgm.createTable('contract_verification_attempts', {
    id: 'id',
    contract_id: {
      type: 'string',
      notNull: true,
    },
    success: {
      type: 'boolean',
      notNull: true,
    },
    message: {
      type: 'text',
      comment: 'Verification result message or error details',
    },
    attempted_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('NOW()'),
    },
  });

  // Index for querying attempts by contract
  pgm.createIndex('contract_verification_attempts', 'contract_id');
  // Index for cleanup/archival of old attempts
  pgm.createIndex('contract_verification_attempts', 'attempted_at');

  // Foreign key reference to contract_verification
  pgm.addConstraint('contract_verification_attempts', 'fk_contract_verification_attempts', {
    foreignKeys: {
      columns: 'contract_id',
      references: 'contract_verification(contract_id)',
      onDelete: 'CASCADE',
    },
  });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropTable('contract_verification_attempts', { cascade: true });
  pgm.dropTable('contract_verification', { cascade: true });
};
