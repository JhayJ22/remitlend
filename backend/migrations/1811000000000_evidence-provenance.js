/**
 * Signed evidence provenance for externally supplied records (#848).
 *
 * Design principles:
 * - Append-only: a Postgres trigger blocks UPDATE and DELETE on all columns.
 *   A correction to a verification result is a new row, never an edit.
 * - No raw payloads are stored. The only content column is `evidence_digest`
 *   (SHA-256 over the canonical JSON of the external record) plus structured
 *   metadata in `verification_detail`.
 * - `row_hmac` is an HMAC-SHA256 over the pipe-joined columns of the row,
 *   keyed with INTERNAL_SIGNING_SECRET, binding every column at insert time so
 *   a row tampered with after the fact can be detected by re-computing the HMAC.
 * - `signing_key_id` records which signing key produced the HMAC so that
 *   key rotation can be verified against the key-rotation audit tables.
 *
 * Supported record_type values (enforced by CHECK constraint):
 *   indexer_event       — Soroban on-chain event parsed by the indexer
 *   quarantine_event    — malformed event sent to quarantine
 *   remittance_ingestion — remittance record ingested from an external source
 *   reconciliation_check  — discrepancy detected by cross-system reconciliation
 *   webhook_delivery     — inbound webhook delivery from a subscriber
 *
 * Verification result values:
 *   verified     — the record passed all integrity and authenticity checks
 *   provisional  — the record was accepted but not yet confirmed on-chain
 *   rejected     — the record failed verification and was discarded
 *   quarantined  — the record was malformed and parked for manual review
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.createTable('evidence_provenance', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },

    /** What kind of external record this evidence row binds. */
    record_type: {
      type: 'varchar(64)',
      notNull: true,
      check: `record_type IN (
        'indexer_event',
        'quarantine_event',
        'remittance_ingestion',
        'reconciliation_check',
        'webhook_delivery'
      )`,
    },

    /**
     * External identifier for the record (event_id, delivery_id, tx_hash, etc.).
     * Used for correlation queries; not required to be globally unique across
     * record types — uniqueness is (record_type, record_ref, evidence_digest).
     */
    record_ref: { type: 'varchar(255)', notNull: true },

    /**
     * Who or what supplied the record. Examples:
     *   contract:C...      — Soroban contract that emitted the event
     *   rpc:hash            — SHA-256 of the RPC endpoint URL (privacy-preserving)
     *   webhook:subscriber_id — inbound webhook subscriber
     */
    source_identity: { type: 'varchar(255)', notNull: true },

    /**
     * SHA-256 hex digest over the canonical JSON serialization of the external
     * record. This is the ONLY content-derived column — the original payload
     * is never stored, so this table can be exposed in public/audit logs.
     */
    evidence_digest: { type: 'varchar(64)', notNull: true },

    /** Digest algorithm, currently always 'sha256'. */
    digest_algorithm: { type: 'varchar(16)', notNull: true, default: 'sha256' },

    /** When the record was ingested (system time, not source time). */
    ingested_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },

    /**
     * Verification outcome. See file header for the four values.
     */
    verification_result: {
      type: 'varchar(32)',
      notNull: true,
      check: `verification_result IN ('verified', 'provisional', 'rejected', 'quarantined')`,
    },

    /**
     * Structured metadata about the verification (ledger, rule_version,
     * error_code, etc.) — never the raw payload.  Kept as jsonb for flexibility.
     */
    verification_detail: { type: 'jsonb', notNull: true, default: "'{}'::jsonb" },

    /**
     * Identifier of the signing key that produced `row_hmac`.
     * Matches the INTERNAL_SIGNING_SECRET (or a rotated successor).
     */
    signing_key_id: { type: 'varchar(128)', notNull: true },

    /**
     * HMAC-SHA256 hex over
     *   `${id}|${record_type}|${record_ref}|${source_identity}|${evidence_digest}|${ingested_at}|${verification_result}`
     * keyed with the internal signing secret.  Detects any tampering after
     * the row is written — re-compute and compare to verify integrity.
     */
    row_hmac: { type: 'varchar(64)', notNull: true },
  });

  // Composite unique constraint: the same record, from the same source, with
  // the same content digest, should produce exactly one evidence row.
  pgm.addConstraint('evidence_provenance', 'evidence_provenance_unique_record', {
    unique: ['record_type', 'record_ref', 'evidence_digest'],
  });

  // Index for common queries: latest evidence per record type, per source.
  pgm.createIndex('evidence_provenance', ['record_type', 'ingested_at']);
  pgm.createIndex('evidence_provenance', ['source_identity', 'ingested_at']);
  pgm.createIndex('evidence_provenance', ['verification_result', 'record_type']);

  // -------------------------------------------------------------------------
  // Immutability trigger — block UPDATE and DELETE on every column.
  // -------------------------------------------------------------------------
  pgm.sql(`
    CREATE OR REPLACE FUNCTION evidence_provenance_immutable() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'evidence_provenance rows are immutable';
      END IF;
      RAISE EXCEPTION 'evidence_provenance rows are append-only — insert a new row instead of updating';
    END;
    $$ LANGUAGE plpgsql;
  `);

  pgm.sql(`
    CREATE TRIGGER evidence_provenance_guard
      BEFORE UPDATE OR DELETE ON evidence_provenance
      FOR EACH ROW EXECUTE FUNCTION evidence_provenance_immutable();
  `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.sql('DROP TRIGGER IF EXISTS evidence_provenance_guard ON evidence_provenance;');
  pgm.sql('DROP FUNCTION IF EXISTS evidence_provenance_immutable();');
  pgm.dropTable('evidence_provenance');
};
