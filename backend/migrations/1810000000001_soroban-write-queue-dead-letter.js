/**
 * Bounded dead-letter state for the Soroban write queue (#857).
 *
 * The durable write queue previously retried a stuck write forever (status
 * stayed `pending`). This migration adds a bounded retry ceiling
 * (`max_attempts`) and dead-letter columns, mirroring the webhook dead-letter
 * pattern (#517). A write that exhausts `max_attempts` is moved to
 * `dead_lettered` (preserving its immutable signed payload) for operator
 * re-drive, so a persistent outage can no longer drive a retry storm.
 *
 * Compatibility: additive columns only. Existing rows back-fill to
 * `max_attempts = 10`; `listReadyForReplay` still selects `status = 'pending'`
 * so dead-lettered rows are excluded from automatic replay.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const up = (pgm) => {
  pgm.addColumns('soroban_write_queue', {
    max_attempts: {
      type: 'integer',
      notNull: true,
      default: 10,
    },
    dead_lettered_at: {
      type: 'timestamp with time zone',
      null: true,
    },
    dead_letter_reason: {
      type: 'text',
      null: true,
    },
  });

  // Allow operators to list dead-lettered writes without a full table scan.
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS soroban_write_queue_dead_lettered_at_index
      ON soroban_write_queue (dead_lettered_at)
      WHERE dead_lettered_at IS NOT NULL;
  `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
  pgm.sql(`DROP INDEX IF EXISTS soroban_write_queue_dead_lettered_at_index;`);
  pgm.dropColumns('soroban_write_queue', ['max_attempts', 'dead_lettered_at', 'dead_letter_reason']);
};
