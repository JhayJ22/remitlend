// Adds event type, tx hash, corridor analytics and amount to nft_transfer_events,
// plus a dedupe index so re-indexing a range is idempotent.
export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE nft_transfer_events
      ADD COLUMN IF NOT EXISTS event_type VARCHAR(32) NOT NULL DEFAULT 'transfer',
      ADD COLUMN IF NOT EXISTS tx_hash VARCHAR(128),
      ADD COLUMN IF NOT EXISTS source_country VARCHAR(8),
      ADD COLUMN IF NOT EXISTS destination_country VARCHAR(8),
      ADD COLUMN IF NOT EXISTS corridor VARCHAR(20),
      ADD COLUMN IF NOT EXISTS amount NUMERIC(38, 0),
      ADD COLUMN IF NOT EXISTS event_time TIMESTAMPTZ;
  `);
  pgm.sql(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_nft_transfer_event
      ON nft_transfer_events (tx_hash, event_type, from_address, to_address)
      WHERE tx_hash IS NOT NULL;
  `);
  pgm.sql(
    `CREATE INDEX IF NOT EXISTS idx_nft_transfer_corridor ON nft_transfer_events (corridor);`,
  );
};

export const down = (pgm) => {
  pgm.sql(`DROP INDEX IF EXISTS idx_nft_transfer_corridor;`);
  pgm.sql(`DROP INDEX IF EXISTS uq_nft_transfer_event;`);
  pgm.sql(`
    ALTER TABLE nft_transfer_events
      DROP COLUMN IF EXISTS event_time,
      DROP COLUMN IF EXISTS amount,
      DROP COLUMN IF EXISTS corridor,
      DROP COLUMN IF EXISTS destination_country,
      DROP COLUMN IF EXISTS source_country,
      DROP COLUMN IF EXISTS tx_hash,
      DROP COLUMN IF EXISTS event_type;
  `);
};
