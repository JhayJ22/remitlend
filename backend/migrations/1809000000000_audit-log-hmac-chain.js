/**
 * Tamper-evident HMAC chain for audit_logs (#796).
 *
 * Each row stores `prev_hmac` (the previous row's hmac, or the genesis hash for
 * the first chained row) and `hmac` = HMAC-SHA256 over
 * prev_hmac|id|actor|action|resource|timestamp keyed with AUDIT_LOG_KEY.
 * Rows written before this migration keep NULL and are reported as legacy
 * (unchained) by the verifier.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.addColumns('audit_logs', {
    prev_hmac: { type: 'char(64)', notNull: false },
    hmac: { type: 'char(64)', notNull: false },
  });
  pgm.createIndex('audit_logs', 'hmac', { name: 'audit_logs_hmac_idx', where: 'hmac IS NOT NULL' });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropIndex('audit_logs', 'hmac', { name: 'audit_logs_hmac_idx' });
  pgm.dropColumns('audit_logs', ['prev_hmac', 'hmac']);
};
