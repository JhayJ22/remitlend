import type { Request, Response } from 'express';
import logger from '../utils/logger.js';

interface CSPViolation {
  'document-uri': string;
  'violated-directive': string;
  'original-policy': string;
  'blocked-uri'?: string;
  'source-file'?: string;
  'line-number'?: number;
  'column-number'?: number;
  disposition: 'enforce' | 'report';
}

interface CSPReport {
  'csp-report': CSPViolation;
}

export async function reportCSPViolation(req: Request, res: Response): Promise<void> {
  const report = req.body as CSPReport | undefined;

  if (!report || !report['csp-report']) {
    res.status(400).json({ error: 'Invalid CSP report format' });
    return;
  }

  const violation = report['csp-report'];

  const violationData = {
    timestamp: new Date().toISOString(),
    documentUri: violation['document-uri'],
    violatedDirective: violation['violated-directive'],
    originalPolicy: violation['original-policy'],
    blockedUri: violation['blocked-uri'],
    sourceFile: violation['source-file'],
    lineNumber: violation['line-number'],
    columnNumber: violation['column-number'],
    disposition: violation.disposition,
  };

  if (violation.disposition === 'enforce') {
    logger.warn('CSP violation (enforced)', violationData);
  } else {
    logger.info('CSP violation (report-only)', violationData);
  }

  res.status(204).send();
}
