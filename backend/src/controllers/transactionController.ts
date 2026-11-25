import type { Request, Response } from 'express';
import pool, { query } from '../db/connection.js';
import { AppError } from '../errors/AppError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  DiagnosticBundleError,
  DiagnosticBundleService,
} from '../services/diagnosticBundleService.js';

const diagnosticBundles = new DiagnosticBundleService(pool);

function translateDiagnosticError(error: unknown): never {
  if (error instanceof DiagnosticBundleError) {
    throw new AppError(error.message, error.statusCode, true);
  }
  throw error;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 500;

function parseLimit(value: unknown): number {
  if (typeof value !== 'string') return DEFAULT_LIMIT;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

function parseCursor(value: unknown): number | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export const listMyTransactions = asyncHandler(async (req: Request, res: Response) => {
  const publicKey = req.user?.publicKey;
  if (!publicKey) {
    throw AppError.unauthorized('Authentication required');
  }

  const limit = parseLimit(req.query.limit);
  const cursor = parseCursor(req.query.cursor);
  const params: Array<string | number> = [publicKey, limit + 1];
  const cursorClause = cursor ? 'AND id < $3' : '';
  if (cursor) params.push(cursor);

  const result = await query(
    `SELECT
         id,
         tx_hash,
         status,
         submitted_at,
         submitted_by,
         transaction_type,
         result_xdr
       FROM transaction_submissions
       WHERE submitted_by = $1
       ${cursorClause}
       ORDER BY id DESC
       LIMIT $2`,
    params,
  );

  const rows = result.rows.slice(0, limit);
  const hasNext = result.rows.length > limit;
  const nextCursor = hasNext ? String(rows[rows.length - 1]?.id) : null;

  res.json({
    success: true,
    data: rows.map((row) => ({
      id: row.id,
      txHash: row.tx_hash,
      status: row.status,
      submittedAt: row.submitted_at,
      submittedBy: row.submitted_by,
      transactionType: row.transaction_type,
      resultXdr: row.result_xdr,
    })),
    page_info: {
      limit,
      count: rows.length,
      next_cursor: nextCursor,
      has_previous: cursor !== null,
      has_next: hasNext,
    },
  });
});

export const createDiagnosticBundle = asyncHandler(async (req: Request, res: Response) => {
  const publicKey = req.user?.publicKey;
  if (!publicKey) {
    throw AppError.unauthorized('Authentication required');
  }

  const body = req.body as { confirm?: unknown } | undefined;
  if (!body || body.confirm !== true) {
    throw AppError.badRequest('Explicit confirmation required to generate a diagnostic bundle');
  }

  const transactionRef = req.params.transactionRef;
  if (typeof transactionRef !== 'string' || transactionRef.trim().length === 0) {
    throw AppError.badRequest('Transaction reference is required');
  }

  let bundle: Awaited<ReturnType<DiagnosticBundleService['createDiagnosticBundle']>>;
  try {
    bundle = await diagnosticBundles.createDiagnosticBundle(transactionRef, publicKey);
  } catch (error) {
    translateDiagnosticError(error);
  }

  res.status(201).json({
    success: true,
    data: {
      id: bundle.bundleId,
      expiresAt: bundle.expiresAt,
    },
  });
});

export const getDiagnosticBundle = asyncHandler(async (req: Request, res: Response) => {
  const publicKey = req.user?.publicKey;
  if (!publicKey) {
    throw AppError.unauthorized('Authentication required');
  }

  const bundleId = req.params.bundleId;
  if (typeof bundleId !== 'string' || bundleId.trim().length === 0) {
    throw AppError.badRequest('Bundle id is required');
  }

  let bundle: Awaited<ReturnType<DiagnosticBundleService['getDiagnosticBundle']>>;
  try {
    bundle = await diagnosticBundles.getDiagnosticBundle(bundleId, publicKey);
  } catch (error) {
    translateDiagnosticError(error);
  }

  res.json({
    success: true,
    data: {
      id: bundle.bundleId,
      createdAt: bundle.createdAt,
      expiresAt: bundle.expiresAt,
      contents: bundle,
    },
  });
});

export const deleteDiagnosticBundle = asyncHandler(async (req: Request, res: Response) => {
  const publicKey = req.user?.publicKey;
  if (!publicKey) {
    throw AppError.unauthorized('Authentication required');
  }

  const bundleId = req.params.bundleId;
  if (typeof bundleId !== 'string' || bundleId.trim().length === 0) {
    throw AppError.badRequest('Bundle id is required');
  }

  try {
    await diagnosticBundles.deleteDiagnosticBundle(bundleId, publicKey);
  } catch (error) {
    translateDiagnosticError(error);
  }

  res.status(204).send();
});
