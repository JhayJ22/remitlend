import type { NextFunction, Request, Response } from 'express';
import crypto from 'crypto';

declare global {
  namespace Express {
    interface Request {
      cspNonce?: string;
    }
  }
}

export function generateCSPNonce(): string {
  return crypto.randomBytes(16).toString('base64');
}

export function cspNonceMiddleware(req: Request, res: Response, next: NextFunction): void {
  const nonce = generateCSPNonce();
  req.cspNonce = nonce;

  res.locals.cspNonce = nonce;

  next();
}

export function getCSPHeaders(nonce: string, isProduction: boolean): Record<string, string> {
  const scriptSrc = isProduction ? `'nonce-${nonce}'` : `'nonce-${nonce}' 'unsafe-inline'`;
  const reportUri = isProduction ? '/api/v1/csp-report' : undefined;

  const directives: Record<string, string> = {
    'default-src': "'self'",
    'script-src': scriptSrc,
    'style-src': "'self' https: 'unsafe-inline'",
    'img-src': "'self' data: https:",
    'font-src': "'self' https: data:",
    'frame-ancestors': "'self'",
    'connect-src': "'self'",
    'form-action': "'self'",
  };

  if (reportUri) {
    directives['report-uri'] = reportUri;
  }

  return {
    'Content-Security-Policy': Object.entries(directives)
      .map(([key, value]) => `${key} ${value}`)
      .join('; '),
  };
}

export function cspHeadersMiddleware(req: Request, res: Response, next: NextFunction): void {
  const isProduction = process.env.NODE_ENV === 'production';
  const nonce = req.cspNonce || generateCSPNonce();

  const cspHeaders = getCSPHeaders(nonce, isProduction);
  Object.entries(cspHeaders).forEach(([key, value]) => {
    res.setHeader(key, value);
  });

  next();
}
