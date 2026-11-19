/**
 * Config integrity monitoring for privileged configuration changes (issue #854).
 *
 * Adds two tables:
 *
 *   config_change_log — append-only record of every privileged configuration
 *     change: actor, prior value, new value, approval reference, effective
 *     time, source, status, and whether an unauthorized-change alert was sent.
 *
 *   config_snapshots — reviewed/approved configuration snapshots used as
 *     recovery targets. A snapshot marks the value at a point in time as
 *     "reviewed and approved"; recovery records a new change_log row that
 *     restores that snapshot value.
 *
 * Both tables are additive; no existing columns are modified.
 */
export const shorthands = undefined;

export const up = (pgm) => {
  // ── config_change_log ──────────────────────────────────────────────────────
  pgm.createTable('config_change_log', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    // Logical key identifying the configuration setting, e.g.
    // "loan.interest_rate_percent" or "pool.reserve_ratio".
    config_key: {
      type: 'varchar(255)',
      notNull: true,
    },
    // Snapshot of the value *before* this change. NULL for the initial write.
    prior_value: {
      type: 'jsonb',
    },
    // The new value after this change.
    new_value: {
      type: 'jsonb',
      notNull: true,
    },
    // Stellar public key (G…) or service identity of the principal that made
    // the change.
    actor: {
      type: 'varchar(255)',
      notNull: true,
    },
    // Reference to the dual-control approval that authorised this change, e.g.
    // the privileged_action_requests.id or an external ticket ID. NULL when no
    // approval was supplied — which triggers the unauthorized-change alert.
    approval_ref: {
      type: 'varchar(255)',
    },
    // When the change takes / took effect on-chain or in the runtime config.
    effective_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('NOW()'),
    },
    // How the change was submitted.
    // 'api'       — through the standard admin API with an approval reference
    // 'direct'    — applied directly (no approval_ref); triggers an alert
    // 'recovery'  — applied as part of restoring a reviewed snapshot
    // 'contract'  — detected as an on-chain contract config event
    change_source: {
      type: 'varchar(32)',
      notNull: true,
      default: 'api',
    },
    // Lifecycle state.
    // 'applied'       — change has taken effect
    // 'unauthorized'  — change was recorded but had no approval_ref
    // 'recovered'     — this entry has been superseded by a recovery action
    status: {
      type: 'varchar(32)',
      notNull: true,
      default: 'applied',
    },
    // True once an alert has been dispatched for an unauthorized change;
    // prevents duplicate alerts on retry.
    alert_sent: {
      type: 'boolean',
      notNull: true,
      default: false,
    },
    // IP address of the caller when available.
    ip_address: {
      type: 'varchar(50)',
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('NOW()'),
    },
  });

  pgm.addConstraint('config_change_log', 'config_change_log_source_check', {
    check: `change_source IN ('api','direct','recovery','contract')`,
  });

  pgm.addConstraint('config_change_log', 'config_change_log_status_check', {
    check: `status IN ('applied','unauthorized','recovered')`,
  });

  // Fast lookup of recent changes per key (most common query pattern).
  pgm.createIndex('config_change_log', ['config_key', 'created_at'], {
    name: 'idx_config_change_log_key_created',
  });
  // Fast scan for all unauthorized entries that need alerting.
  pgm.createIndex('config_change_log', ['status', 'alert_sent'], {
    name: 'idx_config_change_log_status_alert',
  });
  // Audit queries by actor.
  pgm.createIndex('config_change_log', ['actor', 'created_at'], {
    name: 'idx_config_change_log_actor_created',
  });

  // ── config_snapshots ───────────────────────────────────────────────────────
  pgm.createTable('config_snapshots', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    config_key: {
      type: 'varchar(255)',
      notNull: true,
    },
    // The value being captured as a reviewed state.
    value: {
      type: 'jsonb',
      notNull: true,
    },
    // Who captured the snapshot.
    snapshot_by: {
      type: 'varchar(255)',
      notNull: true,
    },
    // Optional reference to the review or approval that blessed this snapshot
    // (e.g. a PR number, Jira ticket, or privileged_action_requests.id).
    review_ref: {
      type: 'varchar(255)',
    },
    // True when a second admin has explicitly marked this snapshot as the
    // reviewed/approved baseline for recovery purposes.
    is_reviewed: {
      type: 'boolean',
      notNull: true,
      default: false,
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('NOW()'),
    },
  });

  pgm.createIndex('config_snapshots', ['config_key', 'created_at'], {
    name: 'idx_config_snapshots_key_created',
  });
  pgm.createIndex('config_snapshots', ['config_key', 'is_reviewed'], {
    name: 'idx_config_snapshots_key_reviewed',
  });
};

export const down = (pgm) => {
  pgm.dropTable('config_snapshots');
  pgm.dropTable('config_change_log');
};
