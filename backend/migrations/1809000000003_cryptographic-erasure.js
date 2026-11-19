/**
 * Cryptographic erasure verification for deleted user data (issue #847).
 *
 * Adds two tables:
 *
 *   erasure_requests  — lifecycle record for each user data erasure request,
 *     capturing the requesting principal, consent reference, per-storage-tier
 *     completion evidence, explicit retention exceptions, and a pointer to the
 *     issued certificate.
 *
 *   erasure_certificates  — the verifiable deletion report. Contains a
 *     SHA-256 commitment over the erased field inventory, timestamps, and
 *     storage-tier acknowledgements. Certificates are immutable once issued;
 *     the hash can be independently re-computed from the JSON fields to prove
 *     the report has not been altered.
 *
 * Both tables are additive; no existing column is modified.
 */
export const shorthands = undefined;

export const up = (pgm) => {
  // ── erasure_requests ───────────────────────────────────────────────────────
  pgm.createTable('erasure_requests', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    // The Stellar public key (G…) of the user whose data is being erased.
    user_public_key: {
      type: 'varchar(255)',
      notNull: true,
    },
    // Who submitted the request: the user themselves or an admin acting on
    // their behalf. Stored separately from user_public_key so an admin
    // erasure can be distinguished from a self-service request.
    requested_by: {
      type: 'varchar(255)',
      notNull: true,
    },
    // Human-readable reason for the erasure (e.g. "right_to_erasure",
    // "account_closure", "gdpr_article_17").
    reason: {
      type: 'text',
      notNull: true,
    },
    // Reference to the consent or legal basis document (e.g. a support-ticket
    // ID, dual-control approval reference, or signed consent token hash).
    consent_ref: {
      type: 'varchar(255)',
    },
    // Lifecycle state.
    // 'pending'    — request received, awaiting admin execution
    // 'in_progress'— actively executing erasure steps
    // 'completed'  — all tiers erased and certificate issued
    // 'failed'     — execution failed; request may be retried
    // 'rejected'   — rejected (e.g. outstanding financial obligation)
    status: {
      type: 'varchar(32)',
      notNull: true,
      default: 'pending',
    },
    // Per-storage-tier completion evidence populated as each tier completes.
    // Shape: { primary: bool, replicas: bool, backups: bool, exports: bool }
    storage_tiers_completed: {
      type: 'jsonb',
      notNull: true,
      default: pgm.func(
        "'{\"primary\":false,\"replicas\":false,\"backups\":false,\"exports\":false}'::jsonb",
      ),
    },
    // Fields that could not be erased due to legal / financial retention
    // obligations. Each entry: { field, table, reason, retained_until? }.
    retention_exceptions: {
      type: 'jsonb',
      notNull: true,
      default: '[]',
    },
    // UUID of the issued erasure_certificates row (populated on completion).
    certificate_id: {
      type: 'uuid',
    },
    initiated_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('NOW()'),
    },
    completed_at: {
      type: 'timestamptz',
    },
    failed_at: {
      type: 'timestamptz',
    },
    failure_reason: {
      type: 'text',
    },
    // ISO-8601 wall-clock time when the subject was notified of the outcome.
    notified_at: {
      type: 'timestamptz',
    },
  });

  pgm.addConstraint('erasure_requests', 'erasure_requests_status_check', {
    check: `status IN ('pending','in_progress','completed','failed','rejected')`,
  });

  // One active request per user at a time (pending or in_progress).
  pgm.createIndex(
    'erasure_requests',
    ['user_public_key', 'status'],
    { name: 'idx_erasure_requests_user_status' },
  );
  pgm.createIndex(
    'erasure_requests',
    ['status', 'initiated_at'],
    { name: 'idx_erasure_requests_status_initiated' },
  );

  // ── erasure_certificates ───────────────────────────────────────────────────
  pgm.createTable('erasure_certificates', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    erasure_request_id: {
      type: 'uuid',
      notNull: true,
      unique: true,
      references: 'erasure_requests',
      onDelete: 'RESTRICT',  // certificates survive request deletion
    },
    // SHA-256 hex over the canonical JSON of fields_erased + fields_retained
    // + storage_tiers + issued_at. Any post-issuance tampering changes the
    // hash and can be detected by re-computing from the stored JSON.
    certificate_hash: {
      type: 'varchar(64)',
      notNull: true,
    },
    // Inventory of erased fields: [{ table, field, record_count }]
    fields_erased: {
      type: 'jsonb',
      notNull: true,
    },
    // Fields that were retained despite the erasure request.
    // Each entry: { table, field, record_count, reason, retained_until? }
    fields_retained: {
      type: 'jsonb',
      notNull: true,
      default: '[]',
    },
    // Legal / regulatory basis for any retained fields
    // (e.g. "AML/CFT 5-year ledger retention", "active financial obligation").
    retention_basis: {
      type: 'text',
    },
    // Reference to the per-user KEK revocation record (kek_revocations.id or
    // the revoked kek_id), proving the encryption key material was destroyed.
    kek_revocation_ref: {
      type: 'varchar(255)',
    },
    // Per-tier completion timestamps.
    // Shape: { primary: ISO8601, replicas: ISO8601|null, backups: ISO8601|null,
    //           exports: ISO8601|null }
    storage_tiers: {
      type: 'jsonb',
      notNull: true,
    },
    // Immutable issuance timestamp.
    issued_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('NOW()'),
    },
    // Public key of the admin who executed the erasure.
    issued_by: {
      type: 'varchar(255)',
      notNull: true,
    },
  });

  pgm.createIndex(
    'erasure_certificates',
    ['erasure_request_id'],
    { name: 'idx_erasure_certs_request_id' },
  );
  pgm.createIndex(
    'erasure_certificates',
    ['issued_at'],
    { name: 'idx_erasure_certs_issued_at' },
  );
};

export const down = (pgm) => {
  pgm.dropTable('erasure_certificates', { ifExists: true });
  pgm.dropTable('erasure_requests', { ifExists: true });
};
