/**
 * Break-glass production access grants (issue #849).
 *
 * A break-glass grant is an emergency, time-limited, independently-approved
 * elevation of access for a named operator. It is NOT an individual action
 * (those live in privileged_action_requests). It is a persistent capability
 * grant: the operator may perform any action within the granted scopes until
 * the grant expires or is revoked.
 *
 * Mandatory requirements enforced by this schema:
 *   1. Ticket reference    — a non-empty incident/change ticket ID must be
 *                            supplied at request time (audit trail anchor).
 *   2. Stated reason       — human-readable justification ≥ 20 characters.
 *   3. Requested scopes    — the requester declares exactly which scopes they
 *                            need (least-privilege: they cannot self-grant more
 *                            than what the approver explicitly confirms).
 *   4. Independent approval — the approver must be a different admin wallet
 *                             (DB-level CHECK + application-level guard).
 *   5. Time limit          — expires_at is mandatory; the expiry sweep
 *                            scheduler revokes grants automatically.
 *   6. Alerting anchors    — alert_sent_at tracks when the alert was fired so
 *                            monitoring can detect missing alerts.
 *   7. Immutable audit     — this table is append-only for core evidence
 *                            columns; a PL/pgSQL trigger blocks edits to
 *                            ticket_ref, requester, reason, requested_scopes,
 *                            and created_at.
 *
 * State machine:
 *   pending  → approved (independent approver grants)
 *   pending  → denied   (approver explicitly denies)
 *   pending  → revoked  (requester or approver cancels before approval)
 *   approved → active   (requester activates within the activation window)
 *   approved → revoked  (revoked before activation or during active window)
 *   active   → expired  (scheduler fires when expires_at passes)
 *   active   → revoked  (any admin revokes early)
 *   denied   — terminal
 *   expired  — terminal
 *   revoked  — terminal
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.createTable('break_glass_grants', {
    id: {
      type: 'bigserial',
      primaryKey: true,
    },

    // ── Identity / audit anchor ─────────────────────────────────────────
    // External incident or change-management ticket (e.g. INC-1234).
    // Required at request time; serves as the external audit anchor.
    ticket_ref: {
      type: 'varchar(128)',
      notNull: true,
    },

    // Human-readable reason for the emergency access (≥ 20 chars enforced by
    // application layer; DB stores as-is so it is included in the audit trail).
    reason: {
      type: 'text',
      notNull: true,
    },

    // ── Principals ──────────────────────────────────────────────────────
    // Stellar public key of the operator requesting emergency access.
    requester: {
      type: 'varchar(56)',
      notNull: true,
    },

    // Stellar public key of the second admin who approved the grant.
    // NULL until the grant is approved or denied.
    approver: {
      type: 'varchar(56)',
      notNull: false,
      default: null,
    },

    // The approver must be a different admin. Enforced at DB level in addition
    // to the application-layer guard.
    // ─ added as a named constraint below so it can be referenced in docs ─

    // ── Scopes ───────────────────────────────────────────────────────────
    // The scopes the requester is asking for (must be a subset of valid
    // admin scopes; application layer validates).
    requested_scopes: {
      type: 'text[]',
      notNull: true,
    },

    // The scopes the approver actually grants (may be a strict subset of
    // requested_scopes — least-privilege principle). Set on approval.
    granted_scopes: {
      type: 'text[]',
      notNull: false,
      default: null,
    },

    // ── State machine ────────────────────────────────────────────────────
    state: {
      type: 'varchar(16)',
      notNull: true,
      default: 'pending',
      check: `state IN (
        'pending',
        'approved',
        'active',
        'denied',
        'expired',
        'revoked'
      )`,
    },

    // ── Time bounds ──────────────────────────────────────────────────────
    // Maximum duration in seconds the grant may remain active.
    // Required; the application enforces an upper ceiling from
    // BREAK_GLASS_MAX_DURATION_HOURS (default 4 h).
    duration_seconds: {
      type: 'integer',
      notNull: true,
    },

    // Set when the grant transitions to `active`. The expiry sweep uses this.
    expires_at: {
      type: 'timestamp with time zone',
      notNull: false,
      default: null,
    },

    // ── Lifecycle timestamps ─────────────────────────────────────────────
    approved_at: {
      type: 'timestamp with time zone',
      notNull: false,
      default: null,
    },
    activated_at: {
      type: 'timestamp with time zone',
      notNull: false,
      default: null,
    },
    revoked_at: {
      type: 'timestamp with time zone',
      notNull: false,
      default: null,
    },
    revoked_by: {
      type: 'varchar(56)',
      notNull: false,
      default: null,
    },
    revocation_reason: {
      type: 'text',
      notNull: false,
      default: null,
    },
    denied_at: {
      type: 'timestamp with time zone',
      notNull: false,
      default: null,
    },
    denial_reason: {
      type: 'text',
      notNull: false,
      default: null,
    },
    expired_at: {
      type: 'timestamp with time zone',
      notNull: false,
      default: null,
    },

    // ── Alerting ─────────────────────────────────────────────────────────
    // Timestamp when the alert notification was sent.  NULL = not yet sent
    // (or alerting not configured). Used by monitoring to detect missing alerts.
    alert_sent_at: {
      type: 'timestamp with time zone',
      notNull: false,
      default: null,
    },
    // Which alert channels were used (informational; e.g. 'email,webhook').
    alert_channels: {
      type: 'text[]',
      notNull: false,
      default: null,
    },

    created_at: {
      type: 'timestamp with time zone',
      notNull: true,
      default: pgm.func('NOW()'),
    },
    updated_at: {
      type: 'timestamp with time zone',
      notNull: true,
      default: pgm.func('NOW()'),
    },
  });

  // ── Constraints ─────────────────────────────────────────────────────────

  // Approver must differ from requester (defense-in-depth beyond app layer).
  pgm.addConstraint('break_glass_grants', 'break_glass_distinct_principals', {
    check: 'approver IS NULL OR approver <> requester',
  });

  // A pending or approved grant cannot have an activation time in the past.
  pgm.addConstraint('break_glass_grants', 'break_glass_expires_after_activation', {
    check: 'expires_at IS NULL OR activated_at IS NULL OR expires_at > activated_at',
  });

  // ── Indexes ─────────────────────────────────────────────────────────────

  // Expiry sweep: find active grants whose expires_at has passed.
  pgm.createIndex('break_glass_grants', ['state', 'expires_at'], {
    name: 'idx_break_glass_active_expiry',
    where: "state = 'active'",
  });

  // Admin queries: find all grants for a given requester.
  pgm.createIndex('break_glass_grants', 'requester', {
    name: 'idx_break_glass_requester',
  });

  // Pending grants awaiting approval.
  pgm.createIndex('break_glass_grants', ['state', 'created_at'], {
    name: 'idx_break_glass_pending',
    where: "state = 'pending'",
  });

  // Ticket reference lookup (for incident correlation).
  pgm.createIndex('break_glass_grants', 'ticket_ref', {
    name: 'idx_break_glass_ticket_ref',
  });

  // ── updated_at trigger ──────────────────────────────────────────────────
  // Reuses update_updated_at_column() created by transaction-submissions.
  pgm.createTrigger('break_glass_grants', 'break_glass_updated_at', {
    when: 'BEFORE',
    operation: 'UPDATE',
    function: 'update_updated_at_column',
  });

  // ── Immutability guard ──────────────────────────────────────────────────
  // Core evidence columns (ticket_ref, requester, reason, requested_scopes,
  // created_at) are immutable once written. Only state-machine columns
  // (state, approver, granted_scopes, timestamps, etc.) may change.
  pgm.sql(`
    CREATE OR REPLACE FUNCTION break_glass_evidence_guard() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'break_glass_grants rows are immutable; set state to revoked instead';
      END IF;
      IF (
        NEW.ticket_ref     IS DISTINCT FROM OLD.ticket_ref  OR
        NEW.requester      IS DISTINCT FROM OLD.requester   OR
        NEW.reason         IS DISTINCT FROM OLD.reason      OR
        NEW.requested_scopes IS DISTINCT FROM OLD.requested_scopes OR
        NEW.created_at     IS DISTINCT FROM OLD.created_at
      ) THEN
        RAISE EXCEPTION 'break_glass_grants evidence columns are immutable (ticket_ref, requester, reason, requested_scopes, created_at)';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  pgm.sql(`
    CREATE TRIGGER break_glass_evidence_guard
      BEFORE UPDATE OR DELETE ON break_glass_grants
      FOR EACH ROW EXECUTE FUNCTION break_glass_evidence_guard();
  `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropTable('break_glass_grants');
  pgm.sql('DROP FUNCTION IF EXISTS break_glass_evidence_guard();');
};
