/**
 * Projection deletion audit index (#853).
 *
 * Adds a composite index on (action, actor, created_at) in audit_logs so that
 * compliance queries filtering by the new 'DELETE /cache/projections' and
 * 'REVOKE cache/projections' action strings are index-backed.
 *
 * Also adds a partial index limited to projection deletion actions so small
 * compliance audits do not need to scan the full audit_logs table.
 *
 * No schema-breaking changes — columns are unchanged; this migration only
 * adds indexes. Down removes them.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  // Composite index used by the compliance query pattern:
  //   WHERE action IN ('DELETE /cache/projections', 'REVOKE cache/projections')
  //   AND created_at BETWEEN $from AND $to
  //   ORDER BY created_at DESC
  pgm.createIndex('audit_logs', ['action', 'created_at'], {
    name: 'audit_logs_action_created_at_idx',
    ifNotExists: true,
  });

  // Partial index covering only the two projection-deletion action strings.
  // Significantly reduces index size compared to a full-table composite index.
  pgm.createIndex('audit_logs', ['actor', 'created_at'], {
    name: 'audit_logs_projection_deletion_idx',
    where: "action IN ('DELETE /cache/projections', 'REVOKE cache/projections')",
    ifNotExists: true,
  });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropIndex('audit_logs', ['actor', 'created_at'], {
    name: 'audit_logs_projection_deletion_idx',
    ifExists: true,
  });
  pgm.dropIndex('audit_logs', ['action', 'created_at'], {
    name: 'audit_logs_action_created_at_idx',
    ifExists: true,
  });
};
