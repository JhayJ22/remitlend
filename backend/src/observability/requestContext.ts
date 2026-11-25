import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  requestId: string;
  traceId?: string;
  service?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Run a callback within a request-scoped AsyncLocalStorage context.
 * All async operations spawned inside (Soroban calls, DB queries,
 * webhook dispatches, notification sends) inherit this context, so
 * the logger can automatically attach requestId/traceId.
 */
export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

/**
 * Returns the active request context, if any. Never throws.
 */
export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Returns the active request ID, if any.
 */
export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/**
 * Returns the active trace ID, if any.
 */
export function getTraceId(): string | undefined {
  return storage.getStore()?.traceId;
}

/**
 * Merge additional fields into the current context (e.g. traceId once
 * traceContext.ts resolves it). No-op when no context is active.
 */
export function updateRequestContext(patch: Partial<RequestContext>): void {
  const current = storage.getStore();
  if (!current) {
    return;
  }
  Object.assign(current, patch);
}
