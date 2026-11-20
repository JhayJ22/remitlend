/**
 * Per-user API keys with scopes, expiry and rotation (#792).
 * Only a SHA-256 hash of the key is stored.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const up = (pgm) => {
  pgm.createTable('api_keys', {
    id: 'id',
    owner: { type: 'varchar(255)', notNull: true },
    key_hash: { type: 'varchar(64)', notNull: true, unique: true },
    key_prefix: { type: 'varchar(16)', notNull: true },
    scopes: { type: 'text[]', notNull: true, default: '{}' },
    expires_at: { type: 'timestamp', notNull: true },
    revoked_at: { type: 'timestamp' },
    rotated_from: { type: 'integer', references: 'api_keys', onDelete: 'SET NULL' },
    expiry_notified_at: { type: 'timestamp' },
    created_at: { type: 'timestamp', notNull: true, default: pgm.func('current_timestamp') },
  });
  pgm.createIndex('api_keys', 'owner');
  pgm.createIndex('api_keys', 'expires_at');
};

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const down = (pgm) => {
  pgm.dropTable('api_keys');
};
