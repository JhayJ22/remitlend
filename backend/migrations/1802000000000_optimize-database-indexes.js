/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * Adds composite and partial indexes to optimize common query patterns.
 *
 * This migration creates indexes targeting:
 * 1. Borrower loan list filters (user_id, status, created_at)
 * 2. Active loan queries (partial indexes)
 * 3. Score breakdown lookups (covering indexes)
 * 4. Event indexing (common filter patterns)
 *
 * All indexes use CREATE INDEX IF NOT EXISTS for idempotency.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const up = async (pgm) => {
  // ─── Loans table indexes ──────────────────────────────────────

  // Composite index for borrower loan list queries with status filter and sorting by creation time
  // Covers: WHERE borrower = $1 AND status = $2 ORDER BY created_at DESC
  pgm.createIndex('loans', ['borrower', 'status', 'created_at'], {
    name: 'idx_loans_borrower_status_created_at',
    ifNotExists: true,
  });

  // Composite index for borrower queries without status filter
  // Covers: WHERE borrower = $1 ORDER BY created_at DESC
  pgm.createIndex('loans', ['borrower', 'created_at'], {
    name: 'idx_loans_borrower_created_at',
    ifNotExists: true,
  });

  // Partial index for active loans (significantly smaller than full loans table)
  // Covers: WHERE status = 'OPEN' ORDER BY created_at DESC
  // Only indexes rows where status is one of the active states
  pgm.createIndex('loans', ['status', 'created_at'], {
    name: 'idx_loans_active_status_created_at',
    ifNotExists: true,
    where: "status IN ('OPEN', 'PENDING')",
  });

  // Index for loan lookup by borrower and status (useful for aggregations)
  pgm.createIndex('loans', ['borrower', 'status'], {
    name: 'idx_loans_borrower_status',
    ifNotExists: true,
  });

  // ─── Contract Events table indexes ─────────────────────────────

  // Composite index for event queries filtered by borrower and event type
  // Covers: WHERE borrower = $1 AND event_type = $2
  pgm.createIndex('contract_events', ['borrower', 'event_type'], {
    name: 'idx_contract_events_borrower_event_type',
    ifNotExists: true,
  });

  // Composite index for event queries filtered by loan and created_at range
  // Covers: WHERE loan_id = $1 ORDER BY created_at DESC
  pgm.createIndex('contract_events', ['loan_id', 'created_at'], {
    name: 'idx_contract_events_loan_id_created_at',
    ifNotExists: true,
  });

  // Partial index for LoanRepaid and LoanDefaulted events (less frequent)
  // Covers default checker and repayment status queries
  pgm.createIndex('contract_events', ['loan_id', 'ledger_closed_at'], {
    name: 'idx_contract_events_loan_repaid_defaulted',
    ifNotExists: true,
    where: "event_type IN ('LoanRepaid', 'LoanDefaulted')",
  });

  // ─── Scores table indexes ────────────────────────────────────

  // Composite index for score lookups by borrower and score type
  // Covers: WHERE borrower = $1 AND score_type = $2
  pgm.createIndex('scores', ['borrower', 'score_type'], {
    name: 'idx_scores_borrower_score_type',
    ifNotExists: true,
  });

  // Index for score breakdown lookups by borrower with creation time
  // Covers: WHERE borrower = $1 ORDER BY created_at DESC
  pgm.createIndex('scores', ['borrower', 'created_at'], {
    name: 'idx_scores_borrower_created_at',
    ifNotExists: true,
  });

  // ─── Remittances table indexes ──────────────────────────────

  // Composite index for remittance queries by sender and status
  // Covers: WHERE sender_id = $1 AND status = $2
  pgm.createIndex('remittances', ['sender_id', 'status'], {
    name: 'idx_remittances_sender_status',
    ifNotExists: true,
  });

  // Composite index for remittance list queries with sorting
  // Covers: WHERE sender_id = $1 ORDER BY created_at DESC
  pgm.createIndex('remittances', ['sender_id', 'created_at'], {
    name: 'idx_remittances_sender_created_at',
    ifNotExists: true,
  });

  // Partial index for completed remittances (most frequent query)
  // Covers: WHERE sender_id = $1 AND status = 'completed'
  pgm.createIndex('remittances', ['sender_id', 'created_at'], {
    name: 'idx_remittances_sender_completed',
    ifNotExists: true,
    where: "status = 'completed'",
  });

  // ─── Audit logs table indexes ──────────────────────────────

  // Composite index for audit log queries by actor and action
  // Covers: WHERE actor = $1 AND action = $2 ORDER BY created_at DESC
  pgm.createIndex('audit_logs', ['actor', 'action', 'created_at'], {
    name: 'idx_audit_logs_actor_action_created_at',
    ifNotExists: true,
  });

  // Index for audit log queries by resource
  pgm.createIndex('audit_logs', ['resource_type', 'resource_id'], {
    name: 'idx_audit_logs_resource',
    ifNotExists: true,
  });

  // ─── Notifications table indexes ─────────────────────────────

  // Composite index for notification queries by recipient and status
  // Covers: WHERE user_id = $1 AND status = $2
  pgm.createIndex('notifications', ['user_id', 'status'], {
    name: 'idx_notifications_user_status',
    ifNotExists: true,
  });

  // Composite index for notification list with sorting
  pgm.createIndex('notifications', ['user_id', 'created_at'], {
    name: 'idx_notifications_user_created_at',
    ifNotExists: true,
  });

  // ─── Loan Disputes table indexes ───────────────────────────

  const disputesTableExists = await pgm.db.query(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'loan_disputes'
    )
  `);

  if (disputesTableExists.rows[0].exists) {
    pgm.createIndex('loan_disputes', ['loan_id', 'created_at'], {
      name: 'idx_loan_disputes_loan_id_created_at',
      ifNotExists: true,
    });

    pgm.createIndex('loan_disputes', ['status', 'created_at'], {
      name: 'idx_loan_disputes_status_created_at',
      ifNotExists: true,
    });

    pgm.createIndex('loan_disputes', ['borrower', 'status'], {
      name: 'idx_loan_disputes_borrower_status',
      ifNotExists: true,
    });
  }
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void>}
 */
export const down = async (pgm) => {
  // Drop loan indexes
  pgm.dropIndex('loans', ['borrower', 'status', 'created_at'], {
    name: 'idx_loans_borrower_status_created_at',
    ifExists: true,
  });
  pgm.dropIndex('loans', ['borrower', 'created_at'], {
    name: 'idx_loans_borrower_created_at',
    ifExists: true,
  });
  pgm.dropIndex('loans', ['status', 'created_at'], {
    name: 'idx_loans_active_status_created_at',
    ifExists: true,
  });
  pgm.dropIndex('loans', ['borrower', 'status'], {
    name: 'idx_loans_borrower_status',
    ifExists: true,
  });

  // Drop contract_events indexes
  pgm.dropIndex('contract_events', ['borrower', 'event_type'], {
    name: 'idx_contract_events_borrower_event_type',
    ifExists: true,
  });
  pgm.dropIndex('contract_events', ['loan_id', 'created_at'], {
    name: 'idx_contract_events_loan_id_created_at',
    ifExists: true,
  });
  pgm.dropIndex('contract_events', ['loan_id', 'ledger_closed_at'], {
    name: 'idx_contract_events_loan_repaid_defaulted',
    ifExists: true,
  });

  // Drop scores indexes
  pgm.dropIndex('scores', ['borrower', 'score_type'], {
    name: 'idx_scores_borrower_score_type',
    ifExists: true,
  });
  pgm.dropIndex('scores', ['borrower', 'created_at'], {
    name: 'idx_scores_borrower_created_at',
    ifExists: true,
  });

  // Drop remittances indexes
  pgm.dropIndex('remittances', ['sender_id', 'status'], {
    name: 'idx_remittances_sender_status',
    ifExists: true,
  });
  pgm.dropIndex('remittances', ['sender_id', 'created_at'], {
    name: 'idx_remittances_sender_created_at',
    ifExists: true,
  });
  pgm.dropIndex('remittances', ['sender_id', 'created_at'], {
    name: 'idx_remittances_sender_completed',
    ifExists: true,
  });

  // Drop audit_logs indexes
  pgm.dropIndex('audit_logs', ['actor', 'action', 'created_at'], {
    name: 'idx_audit_logs_actor_action_created_at',
    ifExists: true,
  });
  pgm.dropIndex('audit_logs', ['resource_type', 'resource_id'], {
    name: 'idx_audit_logs_resource',
    ifExists: true,
  });

  // Drop notifications indexes
  pgm.dropIndex('notifications', ['user_id', 'status'], {
    name: 'idx_notifications_user_status',
    ifExists: true,
  });
  pgm.dropIndex('notifications', ['user_id', 'created_at'], {
    name: 'idx_notifications_user_created_at',
    ifExists: true,
  });

  // Drop loan_disputes indexes if table exists
  const disputesTableExists = await pgm.db.query(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'loan_disputes'
    )
  `);

  if (disputesTableExists.rows[0].exists) {
    pgm.dropIndex('loan_disputes', ['loan_id', 'created_at'], {
      name: 'idx_loan_disputes_loan_id_created_at',
      ifExists: true,
    });
    pgm.dropIndex('loan_disputes', ['status', 'created_at'], {
      name: 'idx_loan_disputes_status_created_at',
      ifExists: true,
    });
    pgm.dropIndex('loan_disputes', ['borrower', 'status'], {
      name: 'idx_loan_disputes_borrower_status',
      ifExists: true,
    });
  }
};
