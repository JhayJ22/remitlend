/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * Append-only event log for loan state transitions (issue #75).
 *
 * Every domain state change for a loan (requested, approved, repaid,
 * defaulted, disputed, liquidated, …) is appended here. The current loan
 * state can be reconstructed by replaying these events in order, which is
 * what the admin replay endpoint does.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {void}
 */
export const up = (pgm) => {
  pgm.createTable('loan_state_events', {
    id: 'id',
    event_id: { type: 'varchar(255)', notNull: true, unique: true },
    loan_id: { type: 'integer', notNull: true },
    event_type: { type: 'varchar(50)', notNull: true },
    payload: { type: 'jsonb', notNull: true, default: '{}' },
    actor: { type: 'varchar(255)' },
    occurred_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
    created_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
  });

  pgm.createIndex('loan_state_events', 'loan_id');
  pgm.createIndex('loan_state_events', 'event_type');
  pgm.createIndex('loan_state_events', ['loan_id', 'occurred_at']);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {void}
 */
export const down = (pgm) => {
  pgm.dropTable('loan_state_events');
};
