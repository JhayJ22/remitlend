/**
 * Network failover + retry-storm event log (#857).
 *
 * Append-only audit table for transaction-submission failover transitions
 * (primary ⇄ failover endpoint), endpoint exhaustion, and retry-storm
 * alert raise/clear events. The event log is the durable, operator-visible
 * counterpart to the in-memory circuit/failover state; it is written
 * best-effort (a transient DB failure never blocks submission).
 *
 * Compatibility: purely additive. No existing table or stored schema is
 * altered. See docs/NETWORK_TELEMETRY.md for the state machine and event
 * semantics.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const up = (pgm) => {
  pgm.createTable('network_failover_events', {
    id: {
      type: 'bigserial',
      primaryKey: true,
    },
    network_id: {
      type: 'varchar(64)',
      notNull: true,
    },
    from_network_id: {
      type: 'varchar(64)',
      null: true,
    },
    event_type: {
      type: 'varchar(40)',
      notNull: true,
    },
    details: {
      type: 'jsonb',
      notNull: true,
      default: pgm.func("'{}'::jsonb"),
    },
    created_at: {
      type: 'timestamp with time zone',
      notNull: true,
      default: pgm.func('NOW()'),
    },
  });

  // Newest-first listing is the common query; also index by network + type.
  pgm.createIndex('network_failover_events', ['created_at'], {
    name: 'network_failover_events_created_at_index',
  });
  pgm.createIndex('network_failover_events', ['network_id', 'created_at'], {
    name: 'network_failover_events_network_created_index',
  });
  pgm.createIndex('network_failover_events', ['event_type', 'created_at'], {
    name: 'network_failover_events_type_created_index',
  });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
  pgm.dropTable('network_failover_events');
};
