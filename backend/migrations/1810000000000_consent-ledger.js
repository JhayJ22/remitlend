/**
 * User-visible consent ledger for sensitive data processing (#845).
 *
 * Design principles:
 * - Append-only: a Postgres trigger blocks UPDATE and DELETE so every consent
 *   grant and revocation is permanently retained for regulatory audit.
 * - Each row records ONE state transition for ONE purpose; to revoke a grant
 *   you INSERT a new row with status='revoked', not UPDATE the original.
 * - policy_version ties the row to the exact privacy policy text that the user
 *   reviewed so a policy change requires fresh consent.
 * - idempotency_key stores the client-supplied Idempotency-Key so duplicated
 *   HTTP requests cannot double-record a grant.
 * - Downstream jobs read the CURRENT effective consent per (user_id, purpose)
 *   via the view consent_effective, not by scanning the full history.
 *
 * Supported purpose codes (enforced by CHECK constraint):
 *   credit_score_processing  — running the credit-score algorithm over repayment history
 *   remittance_analytics     — aggregating remittance amounts for pool analytics
 *   marketing_communications — sending promotional or product-update emails/SMS
 *   third_party_sharing      — sharing anonymised data with regulated third parties
 *
 * Data categories (informational, stored in data_categories jsonb array):
 *   wallet_address | credit_score | remittance_history | loan_history | contact_info
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  // -------------------------------------------------------------------------
  // consent_ledger — append-only history of every consent state transition
  // -------------------------------------------------------------------------
  pgm.createTable('consent_ledger', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },

    /** Stellar public key of the user granting or revoking consent. */
    user_id: { type: 'varchar(255)', notNull: true },

    /**
     * The processing purpose this consent covers.
     * Adding a new purpose requires a migration to extend the CHECK constraint.
     */
    purpose: {
      type: 'varchar(64)',
      notNull: true,
      check: `purpose IN (
        'credit_score_processing',
        'remittance_analytics',
        'marketing_communications',
        'third_party_sharing'
      )`,
    },

    /**
     * State of this consent record.
     * 'granted'  — user actively gave consent.
     * 'revoked'  — user withdrew a prior grant; downstream processing must stop.
     * 'expired'  — set by a background job when policy_version is superseded.
     */
    status: {
      type: 'varchar(16)',
      notNull: true,
      check: "status IN ('granted', 'revoked', 'expired')",
    },

    /**
     * Semantic version of the privacy policy the user reviewed before granting.
     * Format: MAJOR.MINOR (e.g. "1.0", "2.3").  Must be supplied on grant;
     * carry-forward on revoke/expire.
     */
    policy_version: { type: 'varchar(16)', notNull: true },

    /**
     * JSON array of data-category strings that this grant covers.
     * e.g. ["credit_score", "remittance_history"]
     * Stored for user-visible history ("what data was involved?").
     */
    data_categories: { type: 'jsonb', notNull: true, default: "'[]'::jsonb" },

    /**
     * Optional free-text reason supplied by the user when revoking.
     * Null on grant rows.
     */
    revocation_reason: { type: 'text' },

    /**
     * Client-supplied Idempotency-Key from the HTTP request.
     * UNIQUE constraint prevents duplicate consent rows from replayed HTTP
     * requests even if the Redis idempotency cache is cold.
     */
    idempotency_key: { type: 'varchar(255)', notNull: true, unique: true },

    /**
     * IP address captured at grant/revoke time for regulatory evidence.
     * Null if the request came through an internal job (no HTTP context).
     */
    ip_address: { type: 'varchar(64)' },

    /**
     * User-agent string at the time of the action, for audit.
     */
    user_agent: { type: 'text' },

    created_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
  });

  // Composite index for the per-user history view (most recent first).
  pgm.createIndex('consent_ledger', ['user_id', 'purpose', 'created_at']);
  // Index to support "find all grants for a given policy_version" (compliance audits).
  pgm.createIndex('consent_ledger', ['policy_version', 'purpose', 'status']);

  // -------------------------------------------------------------------------
  // Immutability trigger — block UPDATE and DELETE on consent_ledger
  // -------------------------------------------------------------------------
  pgm.sql(`
    CREATE OR REPLACE FUNCTION consent_ledger_immutable() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'consent_ledger rows are immutable — revoke instead of delete';
      END IF;
      RAISE EXCEPTION 'consent_ledger rows are append-only — insert a new row instead of updating';
    END;
    $$ LANGUAGE plpgsql;
  `);

  pgm.sql(`
    CREATE TRIGGER consent_ledger_guard
      BEFORE UPDATE OR DELETE ON consent_ledger
      FOR EACH ROW EXECUTE FUNCTION consent_ledger_immutable();
  `);

  // -------------------------------------------------------------------------
  // consent_effective view — latest status per (user_id, purpose)
  // -------------------------------------------------------------------------
  // Downstream jobs query this view, not the raw table, to decide whether
  // processing is permitted. The DISTINCT ON pattern picks the most recent row.
  pgm.sql(`
    CREATE VIEW consent_effective AS
    SELECT DISTINCT ON (user_id, purpose)
      id,
      user_id,
      purpose,
      status,
      policy_version,
      data_categories,
      created_at AS effective_since
    FROM consent_ledger
    ORDER BY user_id, purpose, created_at DESC;
  `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.sql('DROP VIEW IF EXISTS consent_effective;');
  pgm.sql('DROP TRIGGER IF EXISTS consent_ledger_guard ON consent_ledger;');
  pgm.sql('DROP FUNCTION IF EXISTS consent_ledger_immutable();');
  pgm.dropTable('consent_ledger');
};
