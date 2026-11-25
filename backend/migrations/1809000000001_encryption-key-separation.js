/**
 * Encryption key separation by data classification (issue #846).
 *
 * Adds:
 *  - `pii_encrypted_fields.data_class` — the data classification of each
 *    encrypted field, so rotation/revocation can be scoped to a single class.
 *    Existing rows default to `pii` (the only class populated pre-#846).
 *  - `key_rotation_batch.data_class` — the class a rotation batch targets,
 *    so a batch only re-wraps DEKs of that class and never touches unrelated
 *    classes' ciphertext.
 *  - `kek_revocations` — durable record of revoked KEK ids, loaded into the
 *    in-memory revocation set on startup so the fail-closed property survives
 *    restarts. `kek_id` is unique so revocation is idempotent.
 *
 * Compatibility: every change is additive. No existing column is renamed,
 * removed, or re-typed, and no existing row becomes unreadable — rows without
 * an explicit class behave exactly as before (PII class, single KEK domain).
 */

exports.shorthands = undefined;

const DATA_CLASS_VALUES = `'pii', 'financial', 'credential', 'audit'`;

exports.up = (pgm) => {
  // ── pii_encrypted_fields.data_class ───────────────────────────────────────
  pgm.addColumn('pii_encrypted_fields', {
    data_class: {
      type: 'text',
      notNull: true,
      default: 'pii',
    },
  });

  pgm.addConstraint('pii_encrypted_fields', 'pii_encrypted_fields_data_class_check', {
    check: `data_class IN (${DATA_CLASS_VALUES})`,
  });

  // Supports class-scoped rotation scans: WHERE data_class = $1 AND dek_kek_id = $2.
  pgm.createIndex('pii_encrypted_fields', ['data_class', 'dek_kek_id', 'created_at'], {
    name: 'idx_pii_encrypted_fields_class_kek_created',
  });

  // ── key_rotation_batch.data_class ─────────────────────────────────────────
  pgm.addColumn('key_rotation_batch', {
    data_class: {
      type: 'text',
      notNull: true,
      default: 'pii',
    },
  });

  pgm.addConstraint('key_rotation_batch', 'key_rotation_batch_data_class_check', {
    check: `data_class IN (${DATA_CLASS_VALUES})`,
  });

  pgm.createIndex('key_rotation_batch', ['data_class', 'status', 'initiated_at'], {
    name: 'idx_key_rotation_batch_class_status',
  });

  // ── kek_revocations ────────────────────────────────────────────────────────
  pgm.createTable('kek_revocations', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    kek_id: {
      type: 'text',
      notNull: true,
      unique: true,
    },
    data_class: {
      type: 'text',
      notNull: true,
    },
    revoked_by: {
      type: 'text',
      notNull: true,
    },
    reason: {
      type: 'text',
    },
    request_id: {
      type: 'text',
    },
    revoked_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('NOW()'),
    },
  });

  pgm.addConstraint('kek_revocations', 'kek_revocations_data_class_check', {
    check: `data_class IN (${DATA_CLASS_VALUES})`,
  });

  pgm.createIndex('kek_revocations', ['data_class', 'revoked_at'], {
    name: 'idx_kek_revocations_class_revoked',
  });
};

exports.down = (pgm) => {
  pgm.dropTable('kek_revocations');

  pgm.dropIndex('key_rotation_batch', 'idx_key_rotation_batch_class_status');
  pgm.dropConstraint('key_rotation_batch', 'key_rotation_batch_data_class_check');
  pgm.dropColumn('key_rotation_batch', 'data_class');

  pgm.dropIndex('pii_encrypted_fields', 'idx_pii_encrypted_fields_class_kek_created');
  pgm.dropConstraint('pii_encrypted_fields', 'pii_encrypted_fields_data_class_check');
  pgm.dropColumn('pii_encrypted_fields', 'data_class');
};
