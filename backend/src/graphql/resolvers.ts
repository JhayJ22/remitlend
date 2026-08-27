import { query } from '../db/connection.js';
import type { DataLoaders } from './dataLoaders.js';

interface ResolveContext {
  loaders: DataLoaders;
}

interface LoanArgs {
  id: string;
}

interface ListArgs {
  limit?: number;
  offset?: number;
}

interface PoolArgs {
  token: string;
}

export const resolvers = {
  Query: {
    loan: async (_root: unknown, args: LoanArgs, context: ResolveContext) => {
      return context.loaders.loanLoader.load(args.id);
    },

    loans: async (_root: unknown, args: ListArgs) => {
      const limit = Math.min(args.limit || 10, 100);
      const offset = args.offset || 0;

      const result = await query(`
        SELECT * FROM loans
        ORDER BY created_at DESC
        LIMIT $1 OFFSET $2
      `, [limit, offset]);

      const countResult = await query(`SELECT COUNT(*) as total FROM loans`);

      return {
        edges: result.rows,
        total: parseInt(countResult.rows[0].total, 10),
      };
    },

    score: async (_root: unknown, args: { address: string }, context: ResolveContext) => {
      return context.loaders.scoreLoader.load(args.address);
    },

    scores: async (_root: unknown, args: ListArgs) => {
      const limit = Math.min(args.limit || 10, 100);
      const offset = args.offset || 0;

      const result = await query(`
        SELECT address, score, updated_at FROM users
        ORDER BY updated_at DESC
        LIMIT $1 OFFSET $2
      `, [limit, offset]);

      const countResult = await query(`SELECT COUNT(*) as total FROM users`);

      return {
        edges: result.rows.map((row) => ({
          address: row.address,
          score: row.score,
          updated_at: row.updated_at,
        })),
        total: parseInt(countResult.rows[0].total, 10),
      };
    },

    remittance: async (_root: unknown, args: { id: string }, context: ResolveContext) => {
      return context.loaders.remittanceLoader.load(args.id);
    },

    remittances: async (_root: unknown, args: ListArgs) => {
      const limit = Math.min(args.limit || 10, 100);
      const offset = args.offset || 0;

      const result = await query(`
        SELECT id, recipient, amount, status, metadata_uri, created_at, updated_at
        FROM remittance_events
        ORDER BY created_at DESC
        LIMIT $1 OFFSET $2
      `, [limit, offset]);

      const countResult = await query(`SELECT COUNT(*) as total FROM remittance_events`);

      return {
        edges: result.rows,
        total: parseInt(countResult.rows[0].total, 10),
      };
    },

    poolBalance: async (_root: unknown, args: PoolArgs) => {
      const result = await query(`
        SELECT pool_balance FROM pool_state
        WHERE token = $1
        ORDER BY ledger DESC
        LIMIT 1
      `, [args.token]);

      return result.rows.length > 0 ? result.rows[0].pool_balance : '0';
    },

    totalOutstanding: async (_root: unknown, args: PoolArgs) => {
      const result = await query(`
        SELECT SUM(CAST(amount - principal_paid AS numeric)) as total
        FROM loans
        WHERE status = 'OPEN'
        AND token = $1
      `, [args.token]);

      return result.rows[0].total || '0';
    },
  },
};
