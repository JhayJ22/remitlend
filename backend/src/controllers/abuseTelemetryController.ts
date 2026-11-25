import type { Request, Response } from 'express';
import { abuseTelemetryQuerySchema } from '../schemas/abuseTelemetrySchemas.js';
import { abuseTelemetryService } from '../services/abuseTelemetryService.js';

export async function getAbuseTelemetryReport(req: Request, res: Response): Promise<void> {
  const filters = abuseTelemetryQuerySchema.parse(req.query);
  const report = await abuseTelemetryService.getReport(filters);
  res.json({ success: true, data: report });
}
