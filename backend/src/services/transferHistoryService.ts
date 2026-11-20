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
  event_type?: string;
  tx_hash?: string | null;
  corridor?: string | null;
  amount?: string | null;
  event_time?: Date | null;
}

export interface TransferMetadata {
  sourceCountry: string | null;
  destinationCountry: string | null;
  corridor: string | null;
  amount: string | null;
}

/**
 * Extract corridor analytics (source/destination country pair) and amount from the
 * remittance metadata carried on a transfer event. Accepts snake_case or camelCase
 * keys, optionally nested under `metadata`.
 */
export function extractTransferMetadata(data: unknown): TransferMetadata {
  const root = (data && typeof data === 'object' ? data : {}) as Record<string, any>;
  const meta = (
    root.metadata && typeof root.metadata === 'object' ? root.metadata : root
  ) as Record<string, any>;
  const country = (v: unknown): string | null =>
    typeof v === 'string' && /^[A-Za-z]{2,3}$/.test(v.trim()) ? v.trim().toUpperCase() : null;

  const sourceCountry = country(meta.source_country ?? meta.sourceCountry);
  const destinationCountry = country(meta.destination_country ?? meta.destinationCountry);
  const rawAmount = meta.amount ?? root.amount;
  return {
    sourceCountry,
    destinationCountry,
    corridor: sourceCountry && destinationCountry ? `${sourceCountry}-${destinationCountry}` : null,
    amount: rawAmount !== undefined && rawAmount !== null ? String(rawAmount) : null,
  };
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
  extra: {
    eventType?: 'transfer' | 'score_updated';
    txHash?: string;
    eventTime?: Date;
    metadata?: TransferMetadata | undefined;
  } = {},
): Promise<void> {
  const text = `
    INSERT INTO nft_transfer_events
      (from_address, to_address, score, ledger_sequence, event_type, tx_hash,
       source_country, destination_country, corridor, amount, event_time)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    ON CONFLICT DO NOTHING
  `;
  const m = extra.metadata;

  try {
    await db.query(text, [
      fromAddress,
      toAddress,
      score,
      ledgerSequence,
      extra.eventType ?? 'transfer',
      extra.txHash ?? null,
      m?.sourceCountry ?? null,
      m?.destinationCountry ?? null,
      m?.corridor ?? null,
      m?.amount ?? null,
      extra.eventTime ?? null,
    ]);
  } catch (error) {
    logger.error('Error storing transfer event:', {
      fromAddress,
      toAddress,
      ledgerSequence,
      error,
    });
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
    SELECT id, from_address, to_address, score, ledger_sequence, created_at,
           event_type, tx_hash, corridor, amount, event_time
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

/** Paginated, API-shaped transfer history for an address. */
export async function getTransferHistoryPage(
  address: string,
  limit: number,
  offset: number,
): Promise<{ items: Array<Record<string, unknown>>; total: number }> {
  const [rows, total] = await Promise.all([
    getTransfersForAddress(address, { limit, offset }),
    getTransferCountForAddress(address),
  ]);
  return {
    items: rows.map((r) => ({
      id: r.id,
      type: r.event_type ?? 'transfer',
      from: r.from_address,
      to: r.to_address,
      score: r.score,
      corridor: r.corridor ?? null,
      amount: r.amount ?? null,
      txHash: r.tx_hash ?? null,
      ledger: r.ledger_sequence,
      timestamp: (r.event_time ?? r.created_at) as Date,
    })),
    total,
  };
}

export const transferHistoryService = {
  getTransferHistoryPage,
  extractTransferMetadata,
  storeTransferEvent,
  getTransfersForAddress,
  getIncomingTransfers,
  getOutgoingTransfers,
  getTransfersByLedgerRange,
  getTransferCountForAddress,
  getTransferStats,
};
