/**
 * Operator recovery actions — signed, auditable records for financial recovery
 * tooling (#866).
 *
 * Design principles:
 * - append-only: a Postgres trigger blocks UPDATE and DELETE so every action
 *   is permanently retained for reconciliation.
 * - Exact integer amounts in the smallest unit; never floats.
 * - reason_code is a constrained enum rather than free-text so dashboards and
 *   alert rules can filter without parsing prose.
 * - approval_reference is the external ticket / dual-approval ID that ties this
 *   action back to an out-of-band authorisation record.
 * - idempotency_key carries the client-supplied Idempotency-Key header value so
 *   the outcome record is unambiguously correlated to the HTTP request.
 * - operator_signature is the HMAC-SHA256 hex of
 *   `${operator_id}|${action_type}|${idempotency_key}|${canonical_payload}`
 *   signed with the operator's scoped API key; allows off-line verification.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.createTable('operator_recovery_actions', {
    id: 'id',

    // --- Identity & authorisation ---
    /** Wallet public key (G…) of the operator who submitted the action. */
    operator_id: { type: 'varchar(255)', notNull: true },
    /**
     * Bounded set of supported action types; the application also validates this
     * before INSERT but the CHECK here provides defence-in-depth.
     */
    action_type: {
      type: 'varchar(64)',
      notNull: true,
      check: `action_type IN (
        'reconciliation_retry',
        'reconciliation_resolve',
        'cross_contract_reconcile',
        'loan_state_replay',
        'loan_event_retry'
      )`,
    },
    /**
     * Bounded reason codes so downstream alerting and audit dashboards can
     * filter without parsing prose.
     */
    reason_code: {
      type: 'varchar(64)',
      notNull: true,
      check: `reason_code IN (
        'indexer_lag',
        'contract_event_missed',
        'db_write_failure',
        'duplicate_event',
        'stale_snapshot',
        'manual_reconciliation',
        'operator_requested'
      )`,
    },
    /**
     * External ticket, approval system reference, or dual-control request ID
     * (from privileged_action_requests.id).  Required so every action is
     * traceable to an out-of-band authorisation.
     */
    approval_reference: { type: 'varchar(255)', notNull: true },
    /**
     * Client-supplied Idempotency-Key from the HTTP request.  Stored to
     * correlate the outcome record with the original HTTP request and to
     * prevent duplicate side-effects.
     */
    idempotency_key: { type: 'varchar(255)', notNull: true, unique: true },

    // --- HMAC signature ---
    /**
     * HMAC-SHA256 hex over
     * `${operator_id}|${action_type}|${idempotency_key}|${canonical_payload}`
     * keyed with the operator's scoped API key (admin:recovery scope).
     * Stored for off-line audit verification.
     */
    operator_signature: { type: 'varchar(64)', notNull: true },

    // --- Action payload ---
    /**
     * Canonical, schema-validated JSON payload for the action.  Content varies
     * by action_type but MUST NOT contain private key material or free-form
     * balance overrides.
     */
    payload: { type: 'jsonb', notNull: true },
    /**
     * SHA-256 of `${action_type}\n${canonical_payload}` — matches the scheme
     * used by privileged_action_requests so approvals are bound to exact content.
     */
    payload_hash: { type: 'varchar(64)', notNull: true },

    // --- Outcome (populated at execution time) ---
    status: {
      type: 'varchar(16)',
      notNull: true,
      default: 'pending',
      check: "status IN ('pending', 'executing', 'completed', 'failed', 'rejected')",
    },
    /**
     * Textual reference produced on success (e.g. "discrepancy:42", tx hash).
     */
    outcome_ref: { type: 'varchar(255)' },
    /**
     * Short error message on failure, capped to 500 chars.
     * Sensitive detail MUST NOT be stored here; use the application log for that.
     */
    outcome_error: { type: 'text' },
    executed_at: { type: 'timestamp' },

    // --- Human-readable justification ---
    /** Free-text note (min 10 chars enforced at application layer). */
    reason_note: { type: 'text', notNull: true },

    created_at: { type: 'timestamp', notNull: true, default: pgm.func('current_timestamp') },
  });

  pgm.createIndex('operator_recovery_actions', ['operator_id', 'created_at']);
  pgm.createIndex('operator_recovery_actions', ['action_type', 'status']);
  pgm.createIndex('operator_recovery_actions', 'approval_reference');

  /**
   * Immutability trigger: blocks all DELETEs and blocks any UPDATE to
   * identity, payload, hash, or signature columns once the row is written.
   * Only status, outcome_ref, outcome_error, and executed_at may change
   * (the state-machine transition). The trigger allows this narrow UPDATE
   * set so we do not need a separate outcome table.
   */
  pgm.sql(`
    CREATE OR REPLACE FUNCTION operator_recovery_action_guard() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'operator_recovery_actions rows are immutable';
      END IF;
      -- Allow status-machine updates (status, outcome_ref, outcome_error, executed_at).
      -- Block any change to the identity / payload / signature columns.
      IF (
        NEW.id              IS DISTINCT FROM OLD.id              OR
        NEW.operator_id     IS DISTINCT FROM OLD.operator_id     OR
        NEW.action_type     IS DISTINCT FROM OLD.action_type     OR
        NEW.reason_code     IS DISTINCT FROM OLD.reason_code     OR
        NEW.approval_reference IS DISTINCT FROM OLD.approval_reference OR
        NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR
        NEW.operator_signature IS DISTINCT FROM OLD.operator_signature OR
        NEW.payload         IS DISTINCT FROM OLD.payload         OR
        NEW.payload_hash    IS DISTINCT FROM OLD.payload_hash    OR
        NEW.reason_note     IS DISTINCT FROM OLD.reason_note     OR
        NEW.created_at      IS DISTINCT FROM OLD.created_at
      ) THEN
        RAISE EXCEPTION 'operator recovery action identity/payload columns are immutable';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  pgm.sql(`
    CREATE TRIGGER operator_recovery_actions_guard
      BEFORE UPDATE OR DELETE ON operator_recovery_actions
      FOR EACH ROW EXECUTE FUNCTION operator_recovery_action_guard();
  `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropTable('operator_recovery_actions');
  pgm.sql('DROP FUNCTION IF EXISTS operator_recovery_action_guard();');
};
