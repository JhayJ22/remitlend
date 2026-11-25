export const shorthands = undefined;

export const up = (pgm) => {
  pgm.createTable('abuse_telemetry_events', {
    id: { type: 'bigserial', primaryKey: true },
    event_id: {
      type: 'uuid',
      notNull: true,
      unique: true,
    },
    actor_hash: {
      type: 'char(64)',
      notNull: true,
      check: "actor_hash ~ '^[a-f0-9]{64}$'",
    },
    mutation_type: {
      type: 'varchar(48)',
      notNull: true,
      check:
        "mutation_type IN ('loan_request','loan_repay','loan_submit','loan_deposit_collateral','loan_release_collateral','loan_refinance','loan_extend','loan_liquidate','remittance_create','remittance_submit')",
    },
    decision: {
      type: 'varchar(8)',
      notNull: true,
      check: "decision IN ('allow','block')",
    },
    outcome: {
      type: 'varchar(8)',
      notNull: true,
      check: "outcome IN ('success','failure','blocked')",
    },
    risk_tier: {
      type: 'varchar(8)',
      notNull: true,
      check: "risk_tier IN ('low','medium','high')",
    },
    rate_band: {
      type: 'varchar(8)',
      notNull: true,
      check: "rate_band IN ('one','few','many','burst')",
    },
    attempts_in_window: {
      type: 'integer',
      notNull: true,
      check: 'attempts_in_window BETWEEN 1 AND 10000',
    },
    occurred_at: {
      type: 'timestamp with time zone',
      notNull: true,
      default: pgm.func('NOW()'),
    },
    expires_at: {
      type: 'timestamp with time zone',
      notNull: true,
    },
  });

  pgm.createIndex('abuse_telemetry_events', ['occurred_at'], {
    name: 'abuse_telemetry_events_occurred_at_index',
  });
  pgm.createIndex('abuse_telemetry_events', ['mutation_type', 'occurred_at'], {
    name: 'abuse_telemetry_events_mutation_occurred_index',
  });
  pgm.createIndex('abuse_telemetry_events', ['risk_tier', 'outcome', 'occurred_at'], {
    name: 'abuse_telemetry_events_risk_outcome_occurred_index',
  });
  pgm.createIndex('abuse_telemetry_events', ['expires_at'], {
    name: 'abuse_telemetry_events_expires_at_index',
  });
};

export const down = (pgm) => {
  pgm.dropTable('abuse_telemetry_events');
};
