import { getClient } from './connection.js';
import logger from '../utils/logger.js';
import {
  trackConnectionAcquisition,
  trackConnectionRelease,
  withConnectionTracking,
} from '../middleware/dbConnectionLeakDetector.js';

/**
 * Execute a database transaction with automatic rollback on error
 * @param operations - Array of database operations to execute within the transaction
 * @returns Promise with the result of the operations
 */
export async function withTransaction<T>(
  operations: (client: import('pg').PoolClient) => Promise<T>,
  requestId?: string,
  method?: string,
  path?: string,
): Promise<T> {
  let client;
  const reqId = requestId ?? `txn-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  const reqMethod = method ?? 'UNKNOWN';
  const reqPath = path ?? 'transaction';

  try {
    client = await getClient();
  } catch (error) {
    logger.error('Failed to acquire database client for transaction', {
      error,
      requestId: reqId,
    });
    throw new Error('Database connection failed');
  }

  if (!client) {
    throw new Error('Database client is undefined');
  }

  const clientId = (client as any).processID;
  trackConnectionAcquisition(reqId, reqMethod, reqPath, clientId);

  try {
    await client.query('BEGIN');
    logger.debug('Database transaction started', { requestId: reqId });

    const result = await operations(client);

    await client.query('COMMIT');
    logger.debug('Database transaction committed', { requestId: reqId });

    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('Database transaction rolled back due to error:', {
      error,
      requestId: reqId,
    });
    throw error;
  } finally {
    if (client) {
      client.release();
      trackConnectionRelease(reqId);
    }
  }
}

/**
 * Execute multiple database operations in a transaction
 * @param queries - Array of queries with their parameters
 * @returns Promise with array of results
 */
export async function executeTransactionQueries(
  queries: Array<{ text: string; params?: unknown[] }>,
  requestId?: string,
  method?: string,
  path?: string,
): Promise<unknown[]> {
  return withTransaction(
    async (client) => {
      const results = [];

      for (const query of queries) {
        const result = await client.query(query.text, query.params || []);
        results.push(result);
      }

      return results;
    },
    requestId,
    method,
    path,
  );
}

/**
 * Wrapper for operations that involve both on-chain submission and database writes
 * @param stellarOperation - Function that submits to Stellar network
 * @param dbOperations - Function that performs database writes
 * @returns Promise with combined result
 */
export async function withStellarAndDbTransaction<T>(
  stellarOperation: () => Promise<unknown>,
  dbOperations: (stellarResult: unknown, client: import('pg').PoolClient) => Promise<T>,
  requestId?: string,
  method?: string,
  path?: string,
): Promise<{ stellarResult: unknown; dbResult: T }> {
  return withTransaction(
    async (client) => {
      try {
        // Execute Stellar operation first
        const stellarResult = await stellarOperation();

        // Then execute database operations with the Stellar result
        const dbResult = await dbOperations(stellarResult, client);

        return { stellarResult, dbResult };
      } catch (error) {
        logger.error('Operation failed in Stellar+DB transaction:', {
          error: error instanceof Error ? error.message : 'Unknown error',
          requestId,
          // Don't log sensitive Stellar data
        });

        // Log for reconciliation since Stellar transaction might have succeeded
        // but DB write failed
        logger.warn('Stellar transaction might need manual reconciliation', {
          timestamp: new Date().toISOString(),
          requestId,
        });

        throw error;
      }
    },
    requestId,
    method,
    path,
  );
}
