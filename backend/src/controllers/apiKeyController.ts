import type { Request, Response } from 'express';
import { AppError } from '../errors/AppError.js';
import { createApiKey, rotateApiKey } from '../services/apiKeyService.js';

export async function createKey(req: Request, res: Response): Promise<void> {
  const { scopes, expiresAt } = req.body as { scopes: string[]; expiresAt: string };
  const granted = new Set(req.user!.scopes ?? []);
  // A key may not carry scopes its creator doesn't hold (admin:all covers everything).
  if (!granted.has('admin:all')) {
    const missing = scopes.find((s) => !granted.has(s));
    if (missing) throw AppError.forbidden(`Cannot grant scope you do not hold: ${missing}`);
  }
  const key = await createApiKey(req.user!.publicKey, scopes, expiresAt);
  res.status(201).json({ success: true, data: key });
}

export async function rotateKey(req: Request, res: Response): Promise<void> {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw AppError.badRequest('Invalid API key id');
  const key = await rotateApiKey(req.user!.publicKey, id);
  res.status(201).json({ success: true, data: key });
}
