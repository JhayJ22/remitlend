/**
 * Soroban RPC graceful-degradation write queue (issue #74).
 *
 * Durable FIFO store for signed transactions that could not be submitted
 * because the Soroban RPC endpoint was unavailable. Rows are drained in
 * ascending `id` order by the replay processor once the RPC recovers;
 * `idempotency_key` (the transaction hash) makes a retried enqueue a no-op.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const up = (pgm) => {
  pgm.createTable('soroban_write_queue', {
    id: {
      type: 'bigserial',
      primaryKey: true,
    },
    idempotency_key: {
      type: 'text',
      notNull: true,
      unique: true,
    },
    operation: {
      type: 'varchar(64)',
      notNull: true,
    },
    payload: {
      type: 'jsonb',
      notNull: true,
    },
    status: {
      type: 'varchar(20)',
      notNull: true,
      default: 'pending',
    },
    attempts: {
      type: 'integer',
      notNull: true,
      default: 0,
    },
    last_error: {
      type: 'text',
      null: true,
    },
    next_attempt_at: {
      type: 'timestamp with time zone',
      notNull: true,
      default: pgm.func('NOW()'),
    },
    created_at: {
      type: 'timestamp with time zone',
      notNull: true,
      default: pgm.func('NOW()'),
    },
    updated_at: {
      type: 'timestamp with time zone',
      notNull: true,
      default: pgm.func('NOW()'),
    },
  });

  pgm.createIndex('soroban_write_queue', ['status', 'next_attempt_at', 'id'], {
    name: 'soroban_write_queue_ready_index',
  });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
  pgm.dropTable('soroban_write_queue');
};
