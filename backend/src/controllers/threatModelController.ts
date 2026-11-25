/**
 * Threat-Model Refresh Gate Controller (issue #856)
 *
 * Admin endpoints:
 *   POST /admin/threat-model/reviews            — initiate a review
 *   POST /admin/threat-model/reviews/:id/approve — second-admin approval
 *   GET  /admin/threat-model/reviews            — list reviews
 *   GET  /admin/threat-model/reviews/:id        — single review
 *   GET  /admin/threat-model/reviews/current    — current approved review per boundary
 *   POST /admin/threat-model/changes            — record a boundary change
 *   GET  /admin/threat-model/changes            — change inventory
 *   POST /admin/threat-model/gate-check         — run the gate check for a file list
 */

import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  threatModelRefreshService,
  TRUST_BOUNDARIES,
  REVIEW_TTL_DAYS,
  type TrustBoundary,
} from '../services/threatModelRefreshService.js';
import { AppError } from '../errors/AppError.js';

// ── Validation schemas ────────────────────────────────────────────────────────

const boundarySchema = z.enum(TRUST_BOUNDARIES as unknown as [string, ...string[]]);

const mitigationSchema = z.object({
  id: z.string().min(1).max(32),
  description: z.string().min(1).max(500),
  status: z.enum(['addressed', 'accepted', 'deferred']),
});

const initiateReviewSchema = z.object({
  boundary: boundarySchema,
  document_hash: z
    .string()
    .length(64, 'document_hash must be a 64-character SHA-256 hex string')
    .regex(/^[0-9a-f]{64}$/, 'document_hash must be lowercase hex'),
  mitigations: z.array(mitigationSchema).optional().default([]),
  approval_ref: z.string().max(255).nullable().optional(),
});

const approveReviewSchema = z.object({
  approval_ref: z.string().max(255).optional(),
});

const recordChangeSchema = z.object({
  boundary: boundarySchema,
  change_ref: z.string().min(1).max(255),
  description: z.string().min(1).max(1000),
  changed_files: z.array(z.string().max(500)).min(1),
  force: z.boolean().optional().default(false),
  force_reason: z.string().max(1000).optional(),
});

const gateCheckSchema = z.object({
  files: z.array(z.string().max(500)).min(1, 'At least one file path is required'),
  change_ref: z.string().min(1).max(255).optional().default('manual-check'),
});

// ── Handlers ──────────────────────────────────────────────────────────────────

export async function initiateReview(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = initiateReviewSchema.safeParse(req.body);
    if (!parsed.success) throw AppError.badRequest(parsed.error.issues.map((i) => i.message).join('; '));
    const actor = req.user?.publicKey ?? 'system:api';
    const review = await threatModelRefreshService.initiateReview({
      boundary: parsed.data.boundary as TrustBoundary,
      reviewedBy: actor,
      documentHash: parsed.data.document_hash,
      mitigations: parsed.data.mitigations,
      approvalRef: parsed.data.approval_ref ?? null,
    });
    res.status(202).json({ success: true, data: review });
  } catch (err) {
    next(err);
  }
}

export async function approveReview(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params as { id: string };
    if (!id) throw AppError.badRequest('id is required');
    const parsed = approveReviewSchema.safeParse(req.body);
    if (!parsed.success) throw AppError.badRequest(parsed.error.issues.map((i) => i.message).join('; '));
    const actor = req.user?.publicKey ?? 'system:api';
    const review = await threatModelRefreshService.approveReview({
      reviewId: id,
      approvedBy: actor,
      approvalRef: parsed.data.approval_ref,
    });
    res.json({ success: true, data: review });
  } catch (err) {
    next(err);
  }
}

export async function listReviews(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { boundary, status, limit, cursor } = req.query as Record<string, string | undefined>;
    if (boundary && !TRUST_BOUNDARIES.includes(boundary as TrustBoundary)) {
      throw AppError.badRequest(`boundary must be one of: ${TRUST_BOUNDARIES.join(', ')}`);
    }
    const VALID_STATUSES = ['draft', 'approved', 'superseded'];
    if (status && !VALID_STATUSES.includes(status)) {
      throw AppError.badRequest(`status must be one of: ${VALID_STATUSES.join(', ')}`);
    }
    const parsedLimit = limit ? Math.min(Number(limit), 200) : 50;
    const result = await threatModelRefreshService.listReviews({
      boundary: boundary as TrustBoundary | undefined,
      status: status as 'draft' | 'approved' | 'superseded' | undefined,
      limit: parsedLimit,
      cursor,
    });
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function getReview(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params as { id: string };
    if (!id) throw AppError.badRequest('id is required');
    const review = await threatModelRefreshService.getReview(id);
    // Enrich with an `is_current` flag computed from approved_at.
    const isCurrentForBoundary = review.status === 'approved' && review.approved_at != null;
    const daysUntilExpiry = isCurrentForBoundary
      ? Math.ceil(
          (new Date(review.next_review_due).getTime() - Date.now()) / (1000 * 60 * 60 * 24),
        )
      : null;
    res.json({
      success: true,
      data: { ...review, days_until_expiry: daysUntilExpiry },
    });
  } catch (err) {
    next(err);
  }
}

export async function getCurrentReviews(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    // Return the current approved review for each boundary (or null).
    const results: Record<string, unknown> = {};
    for (const boundary of TRUST_BOUNDARIES) {
      results[boundary] = await threatModelRefreshService.getCurrentReview(boundary as TrustBoundary);
    }
    const allCurrent = TRUST_BOUNDARIES.every((b) => results[b] !== null);
    res.json({
      success: true,
      data: {
        reviews: results,
        all_boundaries_current: allCurrent,
        review_ttl_days: REVIEW_TTL_DAYS,
      },
    });
  } catch (err) {
    next(err);
  }
}

export async function recordChange(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = recordChangeSchema.safeParse(req.body);
    if (!parsed.success) throw AppError.badRequest(parsed.error.issues.map((i) => i.message).join('; '));
    const actor = req.user?.publicKey ?? 'system:api';
    const change = await threatModelRefreshService.recordBoundaryChange({
      boundary: parsed.data.boundary as TrustBoundary,
      changeRef: parsed.data.change_ref,
      description: parsed.data.description,
      changedFiles: parsed.data.changed_files,
      force: parsed.data.force,
      forcedBy: parsed.data.force ? actor : undefined,
      forceReason: parsed.data.force_reason,
    });
    const statusCode = change.gate_status === 'gated' ? 403 : 201;
    res.status(statusCode).json({ success: change.gate_status !== 'gated', data: change });
  } catch (err) {
    next(err);
  }
}

export async function listChanges(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { boundary, gate_status, limit } = req.query as Record<string, string | undefined>;
    if (boundary && !TRUST_BOUNDARIES.includes(boundary as TrustBoundary)) {
      throw AppError.badRequest(`boundary must be one of: ${TRUST_BOUNDARIES.join(', ')}`);
    }
    const parsedLimit = limit ? Math.min(Number(limit), 200) : 50;
    const changes = await threatModelRefreshService.listChanges({
      boundary: boundary as TrustBoundary | undefined,
      gateStatus: gate_status as 'gated' | 'passed' | 'forced' | undefined,
      limit: parsedLimit,
    });
    res.json({ success: true, data: changes });
  } catch (err) {
    next(err);
  }
}

export async function runGateCheck(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = gateCheckSchema.safeParse(req.body);
    if (!parsed.success) throw AppError.badRequest(parsed.error.issues.map((i) => i.message).join('; '));
    const inventory = await threatModelRefreshService.generateChangeInventory({
      files: parsed.data.files,
      changeRef: parsed.data.change_ref,
    });
    const statusCode = inventory.allPassed ? 200 : 403;
    res.status(statusCode).json({ success: inventory.allPassed, data: inventory });
  } catch (err) {
    next(err);
  }
}
