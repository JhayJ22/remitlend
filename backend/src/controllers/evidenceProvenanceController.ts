/**
 * Evidence provenance HTTP controller (#848).
 *
 * All read endpoints require JWT authentication (admin role) so that
 * evidence records — which may reveal ingestion patterns — are not
 * publicly accessible.  The write path (recordEvidence) is called only
 * internally by ingestion jobs; it is not exposed as a public endpoint
 * to prevent injecting fake evidence from outside the trust boundary.
 */

import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../errors/AppError.js';
import {
  listEvidence,
  getEvidence,
  verifyEvidence,
  EVIDENCE_RECORD_TYPES,
  VERIFICATION_RESULTS,
} from '../services/evidenceProvenanceService.js';

/** GET /admin/evidence-provenance */
export const listEvidenceHandler = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const recordType =
      typeof req.query.record_type === 'string' ? req.query.record_type : undefined;
    const sourceIdentity =
      typeof req.query.source_identity === 'string' ? req.query.source_identity : undefined;
    const verificationResult =
      typeof req.query.verification_result === 'string'
        ? req.query.verification_result
        : undefined;
    const limit =
      typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
    const cursor =
      typeof req.query.cursor === 'string' ? req.query.cursor : undefined;

    const records = await listEvidence({
      recordType: recordType as Parameters<typeof listEvidence>[0]['recordType'],
      sourceIdentity,
      verificationResult:
        verificationResult as Parameters<typeof listEvidence>[0]['verificationResult'],
      limit,
      cursor,
    });

    res.json({ success: true, data: { evidence: records } });
  },
);

/** GET /admin/evidence-provenance/:id */
export const getEvidenceHandler = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const id = String(req.params.id ?? '');
    if (!id) throw AppError.badRequest('id is required');
    const record = await getEvidence(id);
    res.json({ success: true, data: record });
  },
);

/** GET /admin/evidence-provenance/:id/verify */
export const verifyEvidenceHandler = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const id = String(req.params.id ?? '');
    if (!id) throw AppError.badRequest('id is required');
    const isValid = await verifyEvidence(id);
    res.json({ success: true, data: { valid: isValid } });
  },
);

/** GET /admin/evidence-provenance/meta */
export const getEvidenceMetaHandler = asyncHandler(
  async (_req: Request, res: Response): Promise<void> => {
    res.json({
      success: true,
      data: {
        record_types: EVIDENCE_RECORD_TYPES,
        verification_results: VERIFICATION_RESULTS,
      },
    });
  },
);
