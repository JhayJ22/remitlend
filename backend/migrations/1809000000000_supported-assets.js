/**
 * Asset allowlist for loan and pool operations (#800).
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const up = (pgm) => {
  pgm.createTable('supported_assets', {
    id: 'id',
    asset_code: { type: 'varchar(12)', notNull: true },
    issuer: { type: 'varchar(56)', notNull: true },
    token_address: { type: 'varchar(56)', notNull: true, unique: true },
    decimals: { type: 'smallint', notNull: true, check: 'decimals BETWEEN 0 AND 18' },
    min_loan_amount: { type: 'numeric(38,0)', notNull: true },
    max_loan_amount: { type: 'numeric(38,0)', notNull: true },
    created_at: { type: 'timestamp', notNull: true, default: pgm.func('current_timestamp') },
  });
  pgm.addConstraint('supported_assets', 'supported_assets_loan_range', {
    check: 'min_loan_amount >= 0 AND max_loan_amount >= min_loan_amount',
  });
  pgm.addConstraint('supported_assets', 'supported_assets_code_issuer_key', {
    unique: ['asset_code', 'issuer'],
  });
};

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const down = (pgm) => {
  pgm.dropTable('supported_assets');
};
