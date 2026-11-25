import { AppError } from '../errors/AppError';
import {
  ERROR_CODES,
  ERROR_REGISTRY,
  getErrorDefinition,
  isRegisteredErrorCode,
} from '../errors/errorCodes';
import { errorHandler } from '../middleware/errorHandler';
import { Request, Response } from 'express';

function createMockResponse(): Response {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}

function createMockRequest(): Request {
  return {} as Request;
}

describe('error code registry', () => {
  it('defines a registry entry for every error code', () => {
    for (const code of Object.values(ERROR_CODES)) {
      const definition = getErrorDefinition(code);
      expect(definition).toBeDefined();
      expect(definition?.code).toBe(code);
      expect(typeof definition?.status).toBe('number');
      expect(definition?.status).toBeGreaterThanOrEqual(400);
      expect(definition?.status).toBeLessThan(600);
      expect(typeof definition?.message).toBe('string');
      expect(definition?.message.length).toBeGreaterThan(0);
      expect(typeof definition?.docsUrl).toBe('string');
      expect(definition?.docsUrl).toMatch(/^https?:\/\//);
    }
  });

  it('has no registry entries without a matching error code', () => {
    const knownCodes = new Set(Object.values(ERROR_CODES));
    for (const code of Object.keys(ERROR_REGISTRY)) {
      expect(knownCodes.has(code as (typeof ERROR_CODES)[keyof typeof ERROR_CODES])).toBe(true);
    }
  });

  it('recognizes registered error codes', () => {
    for (const code of Object.values(ERROR_CODES)) {
      expect(isRegisteredErrorCode(code)).toBe(true);
    }
    expect(isRegisteredErrorCode('NOT_A_REAL_CODE')).toBe(false);
  });
});

describe('AppError subclasses', () => {
  it('every AppError instance uses a registered error code', () => {
    const error = new AppError(ERROR_CODES.INTERNAL_ERROR, 'boom');
    expect(isRegisteredErrorCode(error.code)).toBe(true);
  });

  it('throws when constructed with an unregistered error code', () => {
    expect(() => new AppError('UNREGISTERED_CODE', 'boom')).toThrow();
  });
});

describe('errorHandler', () => {
  it('maps a registered AppError to its registry status and message', () => {
    const code = ERROR_CODES.NOT_FOUND;
    const definition = getErrorDefinition(code)!;
    const req = createMockRequest();
    const res = createMockResponse();
    const next = jest.fn();

    errorHandler(new AppError(code, 'custom detail'), req, res, next);

    expect(res.status).toHaveBeenCalledWith(definition.status);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          code,
          message: expect.any(String),
        }),
      }),
    );
  });

  it('falls back to the internal error definition for unknown errors', () => {
    const req = createMockRequest();
    const res = createMockResponse();
    const next = jest.fn();
    const definition = getErrorDefinition(ERROR_CODES.INTERNAL_ERROR)!;

    errorHandler(new Error('unexpected'), req, res, next);

    expect(res.status).toHaveBeenCalledWith(definition.status);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ code: ERROR_CODES.INTERNAL_ERROR }),
      }),
    );
  });
});
