// Dispute workflow: add under_review/dismissed states support, corrected remittance data,
// and reviewer tracking. Status stays TEXT; transitions are enforced in the service layer.
export const up = (pgm) => {
  pgm.sql(`ALTER TABLE loan_disputes ADD COLUMN IF NOT EXISTS corrected_remittance_data JSONB;`);
  pgm.sql(`ALTER TABLE loan_disputes ADD COLUMN IF NOT EXISTS reviewed_by TEXT;`);
  pgm.sql(`UPDATE loan_disputes SET status = 'dismissed' WHERE status = 'rejected';`);
};

export const down = (pgm) => {
  pgm.sql(`UPDATE loan_disputes SET status = 'rejected' WHERE status = 'dismissed';`);
  pgm.sql(`ALTER TABLE loan_disputes DROP COLUMN IF EXISTS reviewed_by;`);
  pgm.sql(`ALTER TABLE loan_disputes DROP COLUMN IF EXISTS corrected_remittance_data;`);
};
