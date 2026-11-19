/**
 * Config Integrity Controller (issue #854)
 *
 * Admin endpoints:
 *   POST   /admin/config-changes              — record a change
 *   GET    /admin/config-changes              — list changes (filterable)
 *   GET    /admin/config-changes/:id          — single change
 *   POST   /admin/config-changes/:id/recover  — recover to a snapshot
 *   POST   /admin/config-snapshots            — capture a reviewed snapshot
 *   PUT    /admin/config-snapshots/:id/review — mark a snapshot as reviewed
 *   GET    /admin/config-snapshots            — list snapshots
 */

import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { configIntegrityService } from '../services/configIntegrityService.js';
import { AppError } from '../errors/AppError.js';

// ── Validation schemas ────────────────────────────────────────────────────────

const CHANGE_SOURCES = ['api', 'direct', 'recovery', 'contract'] as const;
const CHANGE_STATUSES = ['applied', 'unauthorized', 'recovered'] as const;

export const recordChangeSchema = z.object({
  config_key: z.string().min(1).max(255),
  prior_value: z.unknown().optional(),
  new_value: z.unknown(),
  approval_ref: z.string().max(255).nullable().optional(),
  source: z.enum(CHANGE_SOURCES).optional().default('api'),
  effective_at: z.string().datetime().optional(),
  requires_approval: z.boolean().optional().default(true),
});

export const createSnapshotSchema = z.object({
  config_key: z.string().min(1).max(255),
  value: z.unknown(),
  review_ref: z.string().max(255).nullable().optional(),
  is_reviewed: z.boolean().optional().default(false),
});

export const reviewSnapshotSchema = z.object({
  review_ref: z.string().max(255).optional(),
});

export const recoverSchema = z.object({
  snapshot_id: z.string().uuid(),
  approval_ref: z.string().min(1).max(255),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function ipOf(req: Request): string | null {
  const fwd = req.headers['x-forwarded-for'];
  const raw = Array.isArray(fwd) ? fwd[0] : fwd?.split(',')[0];
  return raw ?? req.ip ?? req.socket.remoteAddress ?? null;
}

// ── Handlers ──────────────────────────────────────────────────────────────────

/**
 * POST /admin/config-changes
 * Record a privileged configuration change with optional approval reference.
 */
export async function recordChange(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const parsed = recordChangeSchema.safeParse(req.body);
    if (!parsed.success) {
      throw AppError.badRequest(parsed.error.issues.map((i) => i.message).join('; '));
    }
    const body = parsed.data;
    const actor = req.user?.publicKey ?? 'system:api';
    const change = await configIntegrityService.recordChange({
      configKey: body.config_key,
      priorValue: body.prior_value ?? null,
      newValue: body.new_value,
      actor,
      approvalRef: body.approval_ref ?? null,
      source: body.source,
      effectiveAt: body.effective_at ? new Date(body.effective_at) : new Date(),
      ipAddress: ipOf(req),
      requiresApproval: body.requires_approval,
    });
    res.status(201).json({ success: true, data: change });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /admin/config-changes
 * List changes with optional filters: config_key, actor, status, source, from, to, limit, cursor.
 */
export async function listChanges(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { config_key, actor, status, source, from, to, limit, cursor } = req.query as Record<string, string | undefined>;

    if (status && !CHANGE_STATUSES.includes(status as (typeof CHANGE_STATUSES)[number])) {
      throw AppError.badRequest(`status must be one of: ${CHANGE_STATUSES.join(', ')}`);
    }
    if (source && !CHANGE_SOURCES.includes(source as (typeof CHANGE_SOURCES)[number])) {
      throw AppError.badRequest(`source must be one of: ${CHANGE_SOURCES.join(', ')}`);
    }
    const parsedLimit = limit ? Math.min(Number(limit), 200) : 50;
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
      throw AppError.badRequest('limit must be a positive integer');
    }

    const result = await configIntegrityService.listChanges({
      configKey: config_key,
      actor,
      status: status as (typeof CHANGE_STATUSES)[number] | undefined,
      source: source as (typeof CHANGE_SOURCES)[number] | undefined,
      from,
      to,
      limit: parsedLimit,
      cursor,
    });
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /admin/config-changes/:id
 * Get a single change log entry by UUID.
 */
export async function getChange(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { id } = req.params as { id: string };
    if (!id) throw AppError.badRequest('id is required');
    const change = await configIntegrityService.getChange(id);
    res.json({ success: true, data: change });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /admin/config-changes/:id/recover
 * Recover the config key referenced in an existing change log entry to a
 * reviewed snapshot. Body: { snapshot_id, approval_ref }.
 */
export async function recoverChange(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const parsed = recoverSchema.safeParse(req.body);
    if (!parsed.success) {
      throw AppError.badRequest(parsed.error.issues.map((i) => i.message).join('; '));
    }
    const { snapshot_id, approval_ref } = parsed.data;
    const actor = req.user?.publicKey ?? 'system:api';
    const change = await configIntegrityService.recoverToSnapshot({
      snapshotId: snapshot_id,
      actor,
      approvalRef: approval_ref,
      ipAddress: ipOf(req),
    });
    res.status(201).json({ success: true, data: change });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /admin/config-snapshots
 * Capture a snapshot of a config key's current value for future recovery.
 */
export async function createSnapshot(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const parsed = createSnapshotSchema.safeParse(req.body);
    if (!parsed.success) {
      throw AppError.badRequest(parsed.error.issues.map((i) => i.message).join('; '));
    }
    const body = parsed.data;
    const actor = req.user?.publicKey ?? 'system:api';
    const snap = await configIntegrityService.createSnapshot({
      configKey: body.config_key,
      value: body.value,
      snapshotBy: actor,
      reviewRef: body.review_ref ?? null,
      isReviewed: body.is_reviewed,
    });
    res.status(201).json({ success: true, data: snap });
  } catch (err) {
    next(err);
  }
}

/**
 * PUT /admin/config-snapshots/:id/review
 * Mark a snapshot as reviewed (second-admin approval).
 */
export async function reviewSnapshot(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { id } = req.params as { id: string };
    if (!id) throw AppError.badRequest('id is required');
    const parsed = reviewSnapshotSchema.safeParse(req.body);
    if (!parsed.success) {
      throw AppError.badRequest(parsed.error.issues.map((i) => i.message).join('; '));
    }
    const actor = req.user?.publicKey ?? 'system:api';
    const snap = await configIntegrityService.reviewSnapshot(id, actor, parsed.data.review_ref);
    res.json({ success: true, data: snap });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /admin/config-snapshots
 * List snapshots, optionally filtered by config_key and is_reviewed.
 */
export async function listSnapshots(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { config_key, is_reviewed, limit } = req.query as Record<string, string | undefined>;
    const parsedLimit = limit ? Math.min(Number(limit), 200) : 50;
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
      throw AppError.badRequest('limit must be a positive integer');
    }
    const snaps = await configIntegrityService.listSnapshots({
      configKey: config_key,
      isReviewed: is_reviewed !== undefined ? is_reviewed === 'true' : undefined,
      limit: parsedLimit,
    });
    res.json({ success: true, data: snaps });
  } catch (err) {
    next(err);
  }
}
