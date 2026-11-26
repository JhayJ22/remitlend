/**
 * Adds an idempotency key to transaction_submissions so a retry of a
 * Soroban submission (e.g. approve_loan / loan disbursement) can be tied to
 * the in-flight chain transaction instead of re-submitting it.
 *
 * @param { import("node-pg-migrate").MigrationBuilder } pgm
 */
export const up = (pgm) => {
  // The XDR hash already lives in tx_hash (the hash of the signed transaction
  // XDR). We only need the client-supplied idempotency key to make replayed
  // HTTP requests resolve back to the original submission.
  pgm.addColumns('transaction_submissions', {
    idempotency_key: {
      type: 'varchar(255)',
      null: true,
    },
  });

  // Uniqueness is enforced by the database, not only by the Redis idempotency
  // cache, so a cold cache cannot produce a second Soroban submission.
  pgm.sql(`
    CREATE UNIQUE INDEX IF NOT EXISTS transaction_submissions_idempotency_key_unique
      ON transaction_submissions (idempotency_key)
      WHERE idempotency_key IS NOT NULL
  `);

  pgm.createIndex('transaction_submissions', ['idempotency_key'], {
    name: 'transaction_submissions_idempotency_key_idx',
  });
};

/**
 * @param { import("node-pg-migrate").MigrationBuilder } pgm
 */
export const down = (pgm) => {
  pgm.sql('DROP INDEX IF EXISTS transaction_submissions_idempotency_key_unique');
  pgm.sql('DROP INDEX IF EXISTS transaction_submissions_idempotency_key_idx');
  pgm.dropColumns('transaction_submissions', ['idempotency_key']);
};
