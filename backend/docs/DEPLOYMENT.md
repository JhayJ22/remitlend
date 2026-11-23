# Deployment Guide

## Structured Logging

The backend emits structured JSON logs. Every log line is a single JSON object with the
following fields:

| Field       | Type   | Description                                                                 |
|-------------|--------|-----------------------------------------------------------------------------|
| `level`     | string | Log level (`debug`, `info`, `warn`, `error`).                                 |
| `timestamp` | string | ISO-8601 timestamp of when the log line was emitted.                        |
| `requestId` | string | Correlation ID for the originating HTTP request (omitted outside a request).|
| `traceId`   | string | Distributed trace ID when a trace context is active (omitted otherwise).    |
| `service`   | string | Service name emitting the log (e.g. `backend`).                             |
| `message`   | string | Human-readable log message.                                                 |
| `data`      | object | Optional structured data attached to the log line.                          |

### Request correlation

Request correlation is implemented with Node.js `AsyncLocalStorage` (`requestContext.ts`).
The request ID is stored for the duration of the request lifecycle, so any log line emitted
within that context — including Soroban calls, DB queries, webhook dispatches, and
notification sends — automatically inherits the `requestId` without per-call plumbing.

When a trace context is active (`traceContext.ts`), the `traceId` is included on every log
line as well, allowing correlation across services.

### Example

```json
{"level":"info","timestamp":"2024-01-01T00:00:00.000Z","requestId":"a1b2c3","traceId":"t9x8y7","service":"backend","message":"soroban call completed","data":{"contract":"multisig","durationMs":42}}
```

Logs can be correlated in production by filtering on `requestId` (single request) or
`traceId` (cross-service trace).
