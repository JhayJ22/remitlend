import { query, withTransaction, type PoolClient } from '../db/connection.js';
import logger from '../utils/logger.js';
import { AppError } from '../errors/AppError.js';

export interface NftTransferRecord {
  id: number;
  from_address: string;
  to_address: string;
  score: number;
  ledger_sequence: number;
  created_at: Date;
}

export interface TransferHistoryOptions {
  limit?: number;
  offset?: number;
  orderBy?: 'ledger' | 'date';
}

/**
 * Store a transfer event in the database.
 * Called by the event indexer when processing NftTransferred events.
 */
export async function storeTransferEvent(
  db: PoolClient,
  fromAddress: string,
  toAddress: string,
  score: number,
  ledgerSequence: number,
): Promise<void> {
  const text = `
    INSERT INTO nft_transfer_events (from_address, to_address, score, ledger_sequence)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT DO NOTHING
  `;

  try {
    await db.query(text, [fromAddress, toAddress, score, ledgerSequence]);
  } catch (error) {
    logger.error('Error storing transfer event:', { fromAddress, toAddress, ledgerSequence, error });
    throw new AppError('Failed to store transfer event', 500);
  }
}

/**
 * Get all transfers (incoming and outgoing) for an address.
 */
export async function getTransfersForAddress(
  address: string,
  options: TransferHistoryOptions = {},
): Promise<NftTransferRecord[]> {
  const limit = Math.min(options.limit || 20, 100); // Cap at 100 per request
  const offset = options.offset || 0;
  const orderBy = options.orderBy === 'date' ? 'created_at' : 'ledger_sequence';

  const text = `
    SELECT id, from_address, to_address, score, ledger_sequence, created_at
    FROM nft_transfer_events
    WHERE from_address = $1 OR to_address = $1
    ORDER BY ${orderBy} DESC
    LIMIT $2
    OFFSET $3
  `;

  try {
    const result = await query(text, [address, limit, offset]);
    return result.rows as NftTransferRecord[];
  } catch (error) {
    logger.error('Error fetching transfers for address:', { address, error });
    throw new AppError('Failed to fetch transfer history', 500);
  }
}

/**
 * Get incoming transfers to an address.
 */
export async function getIncomingTransfers(
  toAddress: string,
  options: TransferHistoryOptions = {},
): Promise<NftTransferRecord[]> {
  const limit = Math.min(options.limit || 20, 100);
  const offset = options.offset || 0;
  const orderBy = options.orderBy === 'date' ? 'created_at' : 'ledger_sequence';

  const text = `
    SELECT id, from_address, to_address, score, ledger_sequence, created_at
    FROM nft_transfer_events
    WHERE to_address = $1
    ORDER BY ${orderBy} DESC
    LIMIT $2
    OFFSET $3
  `;

  try {
    const result = await query(text, [toAddress, limit, offset]);
    return result.rows as NftTransferRecord[];
  } catch (error) {
    logger.error('Error fetching incoming transfers:', { toAddress, error });
    throw new AppError('Failed to fetch incoming transfers', 500);
  }
}

/**
 * Get outgoing transfers from an address.
 */
export async function getOutgoingTransfers(
  fromAddress: string,
  options: TransferHistoryOptions = {},
): Promise<NftTransferRecord[]> {
  const limit = Math.min(options.limit || 20, 100);
  const offset = options.offset || 0;
  const orderBy = options.orderBy === 'date' ? 'created_at' : 'ledger_sequence';

  const text = `
    SELECT id, from_address, to_address, score, ledger_sequence, created_at
    FROM nft_transfer_events
    WHERE from_address = $1
    ORDER BY ${orderBy} DESC
    LIMIT $2
    OFFSET $3
  `;

  try {
    const result = await query(text, [fromAddress, limit, offset]);
    return result.rows as NftTransferRecord[];
  } catch (error) {
    logger.error('Error fetching outgoing transfers:', { fromAddress, error });
    throw new AppError('Failed to fetch outgoing transfers', 500);
  }
}

/**
 * Get transfers within a ledger sequence range.
 */
export async function getTransfersByLedgerRange(
  ledgerStart: number,
  ledgerEnd: number,
  options: TransferHistoryOptions = {},
): Promise<NftTransferRecord[]> {
  const limit = Math.min(options.limit || 20, 100);
  const offset = options.offset || 0;

  const text = `
    SELECT id, from_address, to_address, score, ledger_sequence, created_at
    FROM nft_transfer_events
    WHERE ledger_sequence >= $1 AND ledger_sequence <= $2
    ORDER BY ledger_sequence ASC
    LIMIT $3
    OFFSET $4
  `;

  try {
    const result = await query(text, [ledgerStart, ledgerEnd, limit, offset]);
    return result.rows as NftTransferRecord[];
  } catch (error) {
    logger.error('Error fetching transfers by ledger range:', { ledgerStart, ledgerEnd, error });
    throw new AppError('Failed to fetch transfers', 500);
  }
}

/**
 * Get transfer count for an address.
 */
export async function getTransferCountForAddress(address: string): Promise<number> {
  const text = `
    SELECT COUNT(*) as count
    FROM nft_transfer_events
    WHERE from_address = $1 OR to_address = $1
  `;

  try {
    const result = await query(text, [address]);
    return parseInt(result.rows[0].count, 10);
  } catch (error) {
    logger.error('Error getting transfer count:', { address, error });
    throw new AppError('Failed to get transfer count', 500);
  }
}

/**
 * Get transfer statistics for an address.
 */
export async function getTransferStats(
  address: string,
): Promise<{ outgoing: number; incoming: number; average_score: number }> {
  const text = `
    SELECT
      SUM(CASE WHEN from_address = $1 THEN 1 ELSE 0 END) as outgoing,
      SUM(CASE WHEN to_address = $1 THEN 1 ELSE 0 END) as incoming,
      AVG(score) as average_score
    FROM nft_transfer_events
    WHERE from_address = $1 OR to_address = $1
  `;

  try {
    const result = await query(text, [address]);
    return {
      outgoing: parseInt(result.rows[0].outgoing || 0, 10),
      incoming: parseInt(result.rows[0].incoming || 0, 10),
      average_score: parseFloat(result.rows[0].average_score || 0),
    };
  } catch (error) {
    logger.error('Error getting transfer stats:', { address, error });
    throw new AppError('Failed to get transfer statistics', 500);
  }
}

export const transferHistoryService = {
  storeTransferEvent,
  getTransfersForAddress,
  getIncomingTransfers,
  getOutgoingTransfers,
  getTransfersByLedgerRange,
  getTransferCountForAddress,
  getTransferStats,
};
