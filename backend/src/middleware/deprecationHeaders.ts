import type { Request, Response, NextFunction } from 'express';

/**
 * Middleware to add deprecation headers to legacy API routes.
 * Signals to clients that the /api/* endpoints are deprecated in favor of /api/v1/*.
 */
export const deprecationHeadersMiddleware = (_req: Request, res: Response, next: NextFunction) => {
  const sunsetDate = new Date();
  sunsetDate.setFullYear(sunsetDate.getFullYear() + 1);

  res.set('Deprecation', 'true');
  res.set('Sunset', sunsetDate.toUTCString());
  res.set(
    'Link',
    '</api/v1>; rel="successor-version"; title="API v1"',
  );

  next();
};
