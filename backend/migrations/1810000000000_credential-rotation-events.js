/**
 * Credential rotation event tracking (#851).
 *
 * Adds a table to track staged secret rotations across all credential types
 * (database, signing, webhook, encryption).  Stores only rotation metadata —
 * never secret material.  Each rotation progresses through stages:
 *
 *   staged → overlap → propagating → revoking → completed | failed
 *                                          ↘ recovering → rolled_back
 *
 * Compatibility: additive only.  No existing schema is altered.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.createTable('credential_rotation_events', {
    id: {
      type: 'id',
    },
    rotation_id: {
      type: 'uuid',
      notNull: true,
      default: pgm.func('gen_random_uuid()'),
    },
    // Credential type: database, jwt_signing, internal_signing,
    // webhook_inbound, webhook_egress, pii_encryption, soroban_signing
    credential_type: {
      type: 'varchar(50)',
      notNull: true,
    },
    // Subject identifier (e.g. subscriber_id for webhook, kek_id for PII,
    // or 'global' for process-wide secrets).
    subject: {
      type: 'varchar(255)',
      notNull: true,
      default: 'global',
    },
    // Stage: staged, overlap, propagating, revoking, completed, failed,
    // recovering, rolled_back
    stage: {
      type: 'varchar(20)',
      notNull: true,
    },
    // Previous stage (for audit trail of transitions)
    previous_stage: {
      type: 'varchar(20)',
      notNull: false,
    },
    // Actor who initiated or advanced this stage
    actor: {
      type: 'varchar(255)',
      notNull: true,
    },
    // Outcome of this stage: success, partial, failed
    outcome: {
      type: 'varchar(20)',
      notNull: true,
      default: 'success',
    },
    // Non-secret metadata about the rotation (e.g. propagation targets,
    // verification sample size, failure reason).  NEVER contains secret
    // material — only structural identifiers and outcomes.
    metadata: {
      type: 'jsonb',
      notNull: false,
    },
    // Opaque hash of the new secret (SHA-256) for verification without
    // storing the secret itself.  Used to confirm propagation.
    new_secret_hash: {
      type: 'varchar(64)',
      notNull: false,
    },
    created_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
  });

  pgm.addConstraint('credential_rotation_events', 'credential_rotation_stage_check', {
    check:
      "stage IN ('staged', 'overlap', 'propagating', 'revoking', 'completed', 'failed', 'recovering', 'rolled_back')",
  });

  pgm.addConstraint('credential_rotation_events', 'credential_rotation_outcome_check', {
    check: "outcome IN ('success', 'partial', 'failed')",
  });

  pgm.addConstraint('credential_rotation_events', 'credential_rotation_type_check', {
    check:
      "credential_type IN ('database', 'jwt_signing', 'internal_signing', 'webhook_inbound', 'webhook_egress', 'pii_encryption', 'soroban_signing')",
  });

  pgm.createIndex('credential_rotation_events', ['rotation_id']);
  pgm.createIndex('credential_rotation_events', ['credential_type', 'subject']);
  pgm.createIndex('credential_rotation_events', ['stage', 'created_at']);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropTable('credential_rotation_events');
};
