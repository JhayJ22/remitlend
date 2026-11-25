/**
 * Idempotent loan disbursement submission (#756).
 *
 * The HTTP idempotency middleware only caches a response after the request
 * finishes. A Soroban approval can be submitted to the network before the HTTP
 * response is written, so a timeout between submission and confirmation leaves
 * no cached response and a retry would submit a second transaction. This
 * service records the (idempotency_key, xdr_hash) pair BEFORE the chain call
 * and, on replay, polls the existing transaction instead of submitting again.
 */

import { TransactionBuilder } from '@stellar/stellar-sdk';
import { query } from '../db/connection.js';
import { sorobanService } from './sorobanService.js';
import { getStellarNetworkPassphrase } from '../config/stellar.js';
import logger from '../utils/logger.js';

const TX_ALREADY_APPLIED = 'tx_already_applied';
const UNIQUE_VIOLATION = '23505';

export interface DisbursementSubmission {
  id: number;
  idempotencyKey: string;
  xdrHash: string;
  status: string;
  submittedAt: Date;
  resultXdr: string | null;
}

export interface SubmitDisbursementParams {
  idempotencyKey: string;
  signedTxXdr: string;
  loanId: number;
  submittedBy: string;
}

export interface DisbursementResult {
  txHash: string;
  status: string;
  resultXdr?: string;
  replayed: boolean;
}

interface ErrorWithCode {
  code?: unknown;
  message?: unknown;
  response?: { data?: { code?: unknown; message?: unknown } };
  cause?: unknown;
}

const asErrorObject = (error: unknown): ErrorWithCode | null =>
  typeof error === 'object' && error !== null ? (error as ErrorWithCode) : null;

const errorCodes = (error: unknown): string[] => {
  const codes: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    const obj = asErrorObject(current);
    if (!obj) break;
    const candidates = [obj.code, obj.response?.data?.code];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' || typeof candidate === 'number') {
        codes.push(String(candidate).toLowerCase());
      }
    }
    current = obj.cause;
  }
  return codes;
};

/** Horizon reports a re-submitted, already-confirmed transaction with this code. */
export function isTxAlreadyAppliedError(error: unknown): boolean {
  if (errorCodes(error).includes(TX_ALREADY_APPLIED)) return true;
  const obj = asErrorObject(error);
  const message = typeof obj?.message === 'string' ? obj.message.toLowerCase() : '';
  return message.includes(TX_ALREADY_APPLIED) || message.includes('already applied');
}

function isUniqueViolation(error: unknown): boolean {
  return errorCodes(error).includes(UNIQUE_VIOLATION);
}

/** Derives the canonical transaction hash from the signed XDR. */
export function computeXdrHash(signedTxXdr: string): string {
  const tx = TransactionBuilder.fromXDR(signedTxXdr, getStellarNetworkPassphrase());
  return tx.hash().toString('hex');
}

function toSubmission(row: Record<string, unknown>): DisbursementSubmission {
  return {
    id: Number(row.id),
    idempotencyKey: String(row.idempotency_key),
    xdrHash: String(row.tx_hash),
    status: String(row.status),
    submittedAt: new Date(row.submitted_at as string),
    resultXdr: typeof row.result_xdr === 'string' ? row.result_xdr : null,
  };
}

export async function findSubmissionByIdempotencyKey(
  idempotencyKey: string,
): Promise<DisbursementSubmission | null> {
  const result = await query(
    `SELECT id, idempotency_key, tx_hash, status, submitted_at, result_xdr
       FROM transaction_submissions
      WHERE idempotency_key = $1
      LIMIT 1`,
    [idempotencyKey],
  );
  return result.rows[0] ? toSubmission(result.rows[0]) : null;
}

/** Looks up a submission by its XDR hash, independent of the idempotency key. */
export async function findSubmissionByTxHash(
  xdrHash: string,
): Promise<DisbursementSubmission | null> {
  const result = await query(
    `SELECT id, idempotency_key, tx_hash, status, submitted_at, result_xdr
       FROM transaction_submissions
      WHERE tx_hash = $1
      LIMIT 1`,
    [xdrHash],
  );
  return result.rows[0] ? toSubmission(result.rows[0]) : null;
}

/**
 * Resolves a replayed submission by polling the chain for the recorded hash.
 * Never re-submits. A Horizon `tx_already_applied` response is a confirmation
 * that the original transaction succeeded.
 */
export async function resolveExistingSubmission(
  submission: DisbursementSubmission,
): Promise<DisbursementResult> {
  try {
    const polled = await sorobanService.pollTransactionByHash(submission.xdrHash);
    const applied = polled.status === 'SUCCESS' || polled.status === 'DUPLICATE';
    return {
      txHash: submission.xdrHash,
      status: applied ? 'SUCCESS' : polled.status,
      ...(polled.resultXdr ?? submission.resultXdr
        ? { resultXdr: polled.resultXdr ?? submission.resultXdr ?? undefined }
        : {}),
      replayed: true,
    };
  } catch (error) {
    if (isTxAlreadyAppliedError(error)) {
      return {
        txHash: submission.xdrHash,
        status: 'SUCCESS',
        ...(submission.resultXdr ? { resultXdr: submission.resultXdr } : {}),
        replayed: true,
      };
    }
    throw error;
  }
}

async function recordSubmission(params: SubmitDisbursementParams, xdrHash: string): Promise<boolean> {
  const result = await query(
    `INSERT INTO transaction_submissions
       (idempotency_key, tx_hash, status, submitted_at, submitted_by, transaction_type, envelope_xdr)
     VALUES ($1, $2, 'PENDING', NOW(), $3, 'loan', $4)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [params.idempotencyKey, xdrHash, params.submittedBy, params.signedTxXdr],
  );
  return result.rows.length > 0;
}

async function updateSubmissionStatus(
  idempotencyKey: string,
  status: string,
  resultXdr?: string,
): Promise<void> {
  await query(
    `UPDATE transaction_submissions
        SET status = $1, result_xdr = $2
      WHERE idempotency_key = $3`,
    [status, resultXdr ?? null, idempotencyKey],
  );
}

/**
 * Submits a loan disbursement exactly once per idempotency key. The durable
 * submission row is written before the Soroban call so a request that times
 * out after chain submission can be recovered by polling on the next attempt.
 */
export async function submitLoanDisbursement(
  params: SubmitDisbursementParams,
): Promise<DisbursementResult> {
  const xdrHash = computeXdrHash(params.signedTxXdr);

  const existing = await findSubmissionByIdempotencyKey(params.idempotencyKey);
  if (existing) {
    logger.withContext().info('Loan disbursement replay resolved from existing submission', {
      idempotencyKey: params.idempotencyKey,
      loanId: params.loanId,
      xdrHash: existing.xdrHash,
    });
    return resolveExistingSubmission(existing);
  }

  // A different idempotency key may carry the same signed transaction. The
  // tx_hash is unique, so reuse that submission rather than submitting again.
  const existingByHash = await findSubmissionByTxHash(xdrHash);
  if (existingByHash) {
    logger.withContext().info('Loan disbursement replay resolved from existing XDR hash', {
      idempotencyKey: params.idempotencyKey,
      loanId: params.loanId,
      xdrHash,
    });
    return resolveExistingSubmission(existingByHash);
  }

  try {
    if (!(await recordSubmission(params, xdrHash))) {
      // A concurrent request inserted the same key or XDR between the lookups.
      const raced =
        (await findSubmissionByIdempotencyKey(params.idempotencyKey)) ??
        (await findSubmissionByTxHash(xdrHash));
      if (raced) return resolveExistingSubmission(raced);
      throw new Error('Failed to record loan disbursement submission');
    }
  } catch (error) {
    if (isUniqueViolation(error)) {
      const raced =
        (await findSubmissionByIdempotencyKey(params.idempotencyKey)) ??
        (await findSubmissionByTxHash(xdrHash));
      if (raced) return resolveExistingSubmission(raced);
    }
    throw error;
  }

  try {
    const result = await sorobanService.submitSignedTx(params.signedTxXdr);
    await updateSubmissionStatus(params.idempotencyKey, result.status, result.resultXdr);
    return { ...result, replayed: false };
  } catch (error) {
    if (isTxAlreadyAppliedError(error)) {
      await updateSubmissionStatus(params.idempotencyKey, 'SUCCESS');
      return { txHash: xdrHash, status: 'SUCCESS', replayed: true };
    }
    await updateSubmissionStatus(params.idempotencyKey, 'FAILED');
    throw error;
  }
}

export const loanDisbursementService = {
  submitLoanDisbursement,
  findSubmissionByIdempotencyKey,
  resolveExistingSubmission,
  computeXdrHash,
  isTxAlreadyAppliedError,
};
