import { AsyncLocalStorage } from 'node:async_hooks';
import { getTraceContext } from './traceContext';

export interface RequestContext {
  requestId: string;
  traceId?: string;
}

const requestContextStorage = new AsyncLocalStorage<RequestContext>();

/**
 * Run a callback within a request-scoped AsyncLocalStorage context so that
 * every log line emitted during the request lifecycle (Soroban calls, DB
 * queries, webhook dispatches, notification sends) automatically inherits
 * the originating requestId and traceId.
 */
export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return requestContextStorage.run(context, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return requestContextStorage.getStore();
}

export function getRequestId(): string | undefined {
  return requestContextStorage.getStore()?.requestId;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  [key: string]: unknown;
}

const SERVICE_NAME = process.env.SERVICE_NAME || 'backend';

function resolveTraceId(): string | undefined {
  const store = requestContextStorage.getStore();
  if (store?.traceId) {
    return store.traceId;
  }
  try {
    const trace = getTraceContext();
    return trace?.traceId;
  } catch {
    return undefined;
  }
}

function emit(level: LogLevel, message: string, data?: LogFields): void {
  const store = requestContextStorage.getStore();
  const entry: Record<string, unknown> = {
    level,
    timestamp: new Date().toISOString(),
    requestId: store?.requestId,
    traceId: resolveTraceId(),
    service: SERVICE_NAME,
    message,
  };

  if (data && Object.keys(data).length > 0) {
    entry.data = data;
  }

  const line = JSON.stringify(entry);
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  debug(message: string, data?: LogFields): void {
    emit('debug', message, data);
  },
  info(message: string, data?: LogFields): void {
    emit('info', message, data);
  },
  warn(message: string, data?: LogFields): void {
    emit('warn', message, data);
  },
  error(message: string, data?: LogFields): void {
    emit('error', message, data);
  },
};

export default logger;
