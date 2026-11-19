/**
 * Durable reconciliation for orphaned transaction submissions (issue #858).
 *
 * An "orphaned" submission is one where the client or worker lost the response
 * after submitting a signed transaction to the Soroban RPC. The submitting
 * process recorded the tx_hash in transaction_submissions but never received
 * (or persisted) a confirmed/failed result. Without this table the tx may be
 * silently resubmitted — risking a double-execution — or silently dropped.
 *
 * This migration:
 *   1. Adds three reconciliation columns to transaction_submissions so
 *      orphan-detection state is co-located with the original record.
 *   2. Creates orphaned_tx_reconciliation — one row per orphaned intent —
 *      which records the full state-machine history and the evidence gathered
 *      from on-chain lookup.
 *
 * State machine (orphaned_tx_reconciliation.state):
 *   pending_check    → initial; scanner has not yet queried the RPC
 *   finality_pending → RPC returned not-found but the finality window
 *                      has not yet elapsed; resubmission is blocked
 *   confirmed        → chain lookup found the tx; no resubmission needed
 *   failed_on_chain  → chain lookup found the tx with a failed result
 *   orphaned         → finality window elapsed and tx is still not found;
 *                      resubmission is now permitted (once)
 *   resubmitted      → operator or automated process approved resubmission
 *   resolved         → operator manually resolved (e.g. tx was a duplicate)
 *
 * Authoritative source of truth: the Soroban ledger. This table is evidence
 * only; it never alters any financial balances.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  // ── 1. Extend transaction_submissions ───────────────────────────────────
  // These three columns let the reconciler mark a submission without
  // requiring a join to orphaned_tx_reconciliation on the hot read path.

  pgm.addColumn('transaction_submissions', {
    reconciliation_state: {
      type: 'varchar(24)',
      notNull: false, // NULL = not yet classified (pre-existing rows)
      default: null,
    },
    first_checked_at: {
      type: 'timestamp with time zone',
      notNull: false,
      default: null,
    },
    last_checked_at: {
      type: 'timestamp with time zone',
      notNull: false,
      default: null,
    },
  });

  pgm.createIndex('transaction_submissions', 'reconciliation_state', {
    name: 'idx_tx_submissions_reconciliation_state',
    where: 'reconciliation_state IS NOT NULL',
  });

  // Index for the orphan-detection scan: find unfinished submissions older
  // than a TTL threshold without a full table scan.
  pgm.createIndex(
    'transaction_submissions',
    ['submitted_at', 'status', 'reconciliation_state'],
    {
      name: 'idx_tx_submissions_orphan_scan',
      where: "status NOT IN ('confirmed', 'failed') AND submitted_at < NOW()",
    },
  );

  // ── 2. orphaned_tx_reconciliation ───────────────────────────────────────

  pgm.createTable('orphaned_tx_reconciliation', {
    id: {
      type: 'bigserial',
      primaryKey: true,
    },

    // FK to transaction_submissions. ON DELETE RESTRICT: a submission with
    // an open reconciliation row must not be hard-deleted.
    submission_id: {
      type: 'integer',
      notNull: true,
      references: 'transaction_submissions',
      onDelete: 'RESTRICT',
    },

    // Denormalized for query convenience and audit trail immutability.
    tx_hash: {
      type: 'varchar(64)',
      notNull: true,
    },
    submitted_by: {
      type: 'varchar(56)',
      notNull: false,
    },
    transaction_type: {
      type: 'varchar(20)',
      notNull: true,
      default: 'loan',
    },

    // State machine column. CHECK keeps the application-level enum honest.
    state: {
      type: 'varchar(24)',
      notNull: true,
      default: 'pending_check',
      check: `state IN (
        'pending_check',
        'finality_pending',
        'confirmed',
        'failed_on_chain',
        'orphaned',
        'resubmitted',
        'resolved'
      )`,
    },

    // Number of times the reconciler has queried the RPC for this tx.
    check_attempts: {
      type: 'integer',
      notNull: true,
      default: 0,
    },

    // ISO-8601 timestamp of the last RPC lookup attempt.
    last_rpc_check_at: {
      type: 'timestamp with time zone',
      notNull: false,
      default: null,
    },

    // The ledger sequence number at which the tx was found, if confirmed.
    confirmed_ledger: {
      type: 'bigint',
      notNull: false,
      default: null,
    },

    // Raw result XDR returned by the RPC if the tx was found.
    rpc_result_xdr: {
      type: 'text',
      notNull: false,
      default: null,
    },

    // The error returned by the RPC if the tx failed on-chain.
    rpc_error_detail: {
      type: 'text',
      notNull: false,
      default: null,
    },

    // The finality window deadline. The reconciler will not classify a tx as
    // orphaned until after this timestamp so delayed finality is not
    // misidentified as a lost transaction.
    finality_deadline_at: {
      type: 'timestamp with time zone',
      notNull: true,
      // Default: 5 minutes after row creation. Overridable by the service.
      default: pgm.func("NOW() + INTERVAL '5 minutes'"),
    },

    // Resubmission: who approved it and when.
    resubmit_approved_by: {
      type: 'varchar(56)',
      notNull: false,
      default: null,
    },
    resubmitted_at: {
      type: 'timestamp with time zone',
      notNull: false,
      default: null,
    },
    // The new tx_hash if a resubmission was made.
    resubmit_tx_hash: {
      type: 'varchar(64)',
      notNull: false,
      default: null,
    },

    // Operator resolution reason (for resolved state).
    resolution_note: {
      type: 'text',
      notNull: false,
      default: null,
    },
    resolved_by: {
      type: 'varchar(56)',
      notNull: false,
      default: null,
    },
    resolved_at: {
      type: 'timestamp with time zone',
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

  // One active reconciliation row per submission (UNIQUE on submission_id).
  // A second reconciliation for the same submission must be a new row after
  // the previous one reached a terminal state; enforced at the service layer.
  pgm.addConstraint(
    'orphaned_tx_reconciliation',
    'uq_orphaned_tx_submission_id',
    'UNIQUE (submission_id)',
  );

  // Covering index for the reconciler scan: unfinished rows ordered by age.
  pgm.createIndex('orphaned_tx_reconciliation', ['state', 'created_at'], {
    name: 'idx_orphaned_tx_state_created',
    where: "state NOT IN ('confirmed', 'failed_on_chain', 'resubmitted', 'resolved')",
  });

  pgm.createIndex('orphaned_tx_reconciliation', 'tx_hash', {
    name: 'idx_orphaned_tx_hash',
  });

  pgm.createIndex('orphaned_tx_reconciliation', 'submitted_by', {
    name: 'idx_orphaned_tx_submitted_by',
    where: 'submitted_by IS NOT NULL',
  });

  // updated_at trigger re-uses the existing update_updated_at_column() function
  // created by the transaction-submissions migration.
  pgm.createTrigger('orphaned_tx_reconciliation', 'update_orphaned_tx_updated_at', {
    when: 'BEFORE',
    operation: 'UPDATE',
    function: 'update_updated_at_column',
  });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropTable('orphaned_tx_reconciliation');
  pgm.dropColumns('transaction_submissions', [
    'reconciliation_state',
    'first_checked_at',
    'last_checked_at',
  ]);
};
