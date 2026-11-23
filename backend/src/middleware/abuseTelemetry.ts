import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../errors/AppError.js';
import type {
  AbuseMutationType,
  AbuseOutcome,
  AbuseDecision,
  AbuseRateBand,
  AbuseRiskTier,
} from '../schemas/abuseTelemetrySchemas.js';
import {
  abuseTelemetryService,
  type AbuseTelemetryService,
  type Evaluation,
} from '../services/abuseTelemetryService.js';

export interface AbuseTelemetryContext {
  decision: AbuseDecision;
  riskTier: AbuseRiskTier;
  rateBand: AbuseRateBand;
  attemptsInWindow: number;
  dependencyError: boolean;
}

export interface AbuseTelemetryGuardOptions {
  service?: AbuseTelemetryService;
}

export function abuseTelemetryGuard(
  mutationType: AbuseMutationType,
  options: AbuseTelemetryGuardOptions = {},
) {
  const service = options.service ?? abuseTelemetryService;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const actorId = req.user?.publicKey;
    if (!actorId) {
      next();
      return;
    }

    try {
      const isReplay = req.header('X-Idempotent-Replayed') === 'true';
      const evaluation: Evaluation = await service.evaluate({ actorId, mutationType, isReplay });

      const context: AbuseTelemetryContext = {
        decision: evaluation.decision,
        riskTier: evaluation.riskTier,
        rateBand: evaluation.rateBand,
        attemptsInWindow: evaluation.attemptsInWindow,
        dependencyError: evaluation.dependencyError,
      };
      res.locals.abuseTelemetry = context;

      const eventId = crypto.randomUUID();
      let recorded = false;

      if (evaluation.decision === 'block') {
        recorded = true;
        await service.record({
          eventId,
          actorHash: evaluation.actorHash,
          mutationType,
          decision: evaluation.decision,
          outcome: 'blocked',
          riskTier: evaluation.riskTier,
          rateBand: evaluation.rateBand,
          attemptsInWindow: evaluation.attemptsInWindow,
        });
        next(
          AppError.tooManyRequests(
            'Too many financial actions in a short period. Please retry later.',
          ),
        );
        return;
      }

      res.once('finish', () => {
        if (recorded) return;
        recorded = true;
        const outcome: AbuseOutcome = res.statusCode >= 400 ? 'failure' : 'success';
        void service.record({
          eventId,
          actorHash: evaluation.actorHash,
          mutationType,
          decision: evaluation.decision,
          outcome,
          riskTier: evaluation.riskTier,
          rateBand: evaluation.rateBand,
          attemptsInWindow: evaluation.attemptsInWindow,
        });
      });

      next();
    } catch (error) {
      next(error);
    }
  };
}
