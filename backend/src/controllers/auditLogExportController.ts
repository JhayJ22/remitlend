import type { Request, Response } from 'express';
import { AppError } from '../errors/AppError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  iterateAuditLogs,
  verifyAuditRange,
  type AuditRange,
} from '../services/auditLogService.js';

function parseRange(source: Record<string, unknown>): AuditRange {
  const range: AuditRange = {};
  for (const field of ['from', 'to'] as const) {
    const raw = source[field];
    if (raw === undefined || raw === null || raw === '') continue;
    if (typeof raw !== 'string' || Number.isNaN(Date.parse(raw))) {
      throw AppError.badRequest(`${field} must be an ISO-8601 timestamp`);
    }
    range[field] = new Date(raw).toISOString();
  }
  if (range.from && range.to && range.from > range.to) {
    throw AppError.badRequest('from must be before to');
  }
  return range;
}

/**
 * GET /admin/audit-logs/export?from=&to=
 * Streams the range as NDJSON (one entry per line, ascending id) including the
 * prev_hmac/hmac chain fields. Rows are written batch by batch; the response
 * is never buffered in full.
 */
export const exportAuditLogs = asyncHandler(async (req: Request, res: Response) => {
  const range = parseRange(req.query as Record<string, unknown>);

  res.status(200);
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="audit-logs.ndjson"');
  res.setHeader('Cache-Control', 'no-store');

  try {
    for await (const row of iterateAuditLogs(range)) {
      const line = JSON.stringify({
        id: Number(row.id),
        actor: row.actor,
        action: row.action,
        resource: row.target,
        payload: row.payload ?? null,
        ipAddress: row.ip_address ?? null,
        status: row.status ?? null,
        timestamp: new Date(row.created_at).toISOString(),
        prevHmac: row.prev_hmac?.trim() ?? null,
        hmac: row.hmac?.trim() ?? null,
      });
      if (!res.write(`${line}\n`)) {
        await new Promise<void>((resolve) => res.once('drain', resolve));
      }
    }
    res.end();
  } catch (error) {
    // Headers are already sent: terminate the stream so the client sees a
    // truncated (and therefore unverifiable) export rather than a fake success.
    res.destroy(error as Error);
  }
});

/**
 * POST /admin/audit-logs/verify  body: { from?, to? }
 * Recomputes the HMAC chain over the range and reports the first broken link.
 */
export const verifyAuditLogs = asyncHandler(async (req: Request, res: Response) => {
  const range = parseRange((req.body ?? {}) as Record<string, unknown>);
  const result = await verifyAuditRange(range);
  res.status(200).json({
    success: true,
    data: { status: result.valid ? 'pass' : 'fail', range, ...result },
  });
});
