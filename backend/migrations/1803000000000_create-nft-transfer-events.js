/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async (knex) => {
  await knex.schema.createTable('nft_transfer_events', (table) => {
    table.bigIncrements('id').primary();
    table.string('from_address', 56).notNullable();
    table.string('to_address', 56).notNullable();
    table.integer('score').notNullable();
    table.integer('ledger_sequence').notNullable();
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());

    // Indexes for efficient querying
    table.index(['from_address', 'ledger_sequence'], 'idx_nft_transfer_from_ledger');
    table.index(['to_address', 'ledger_sequence'], 'idx_nft_transfer_to_ledger');
    table.index(['ledger_sequence'], 'idx_nft_transfer_ledger');
    table.index(['created_at'], 'idx_nft_transfer_created_at');
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('nft_transfer_events');
};
