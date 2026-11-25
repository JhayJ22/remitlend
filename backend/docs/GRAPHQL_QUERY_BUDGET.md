# GraphQL query budget

Every GraphQL query is measured by a validation rule (`backend/src/graphql/queryBudget.ts`), so
over-budget requests are rejected during validation, before any resolver or database work runs.

## Cost model
- Each field costs 1 unless weighted: collections (`loans`, `scores`, `remittances`) cost 10,
  chain-backed fields (`poolBalance`, `totalOutstanding`) cost 25.
- Children of a collection are multiplied by the literal `limit` argument (50 when absent or a variable).
- Depth is the deepest field nesting; aliases are counted across the whole operation.
- Fragments are expanded. The calculation is deterministic.

## Limits
| Env var | Default |
| --- | --- |
| `GRAPHQL_MAX_DEPTH` | 6 |
| `GRAPHQL_MAX_ALIASES` | 10 |
| `GRAPHQL_MAX_COST` | 1000 |

Values must be positive integers. Malformed, zero, or negative values fall back to the default,
so limits cannot be disabled.

## Rejection
The response is an HTTP 400 with a generic message, `extensions.code = QUERY_BUDGET_EXCEEDED`, and
the request's correlation id (`requestId`). Measured values and schema details are not exposed.
Use the correlation id to find the request in logs.

## Tuning safely
Raise one limit at a time, based on real client queries and database load. Update `FIELD_WEIGHTS`
when adding resolvers that are collection-valued or chain-backed.

## Low-bandwidth clients

Core account journeys (transaction details, security/authorization checks, and stale-data
warnings) must remain fully functional on constrained connections. Clients signal their
rendering mode with the `X-Rendering-Mode` request header; the supported values are:

| Mode | Meaning |
| --- | --- |
| `normal` | Full rendering; optional assets and secondary widgets are loaded. |
| `constrained` | Nonessential assets and optional content are deferred; core journey data is unchanged. |
| `offline` | No network; clients render cached data and must show an explicit stale-data warning. |

Unknown or missing values are treated as `normal`. The header never changes authorization or
consent requirements: security checks and transaction details are always returned in full, and
stale or invalid actions are rejected without partial financial side effects.

### Query budget for constrained clients
Constrained clients should keep queries within the default limits above. When a client defers
optional content, it should drop optional fields rather than raise `GRAPHQL_MAX_COST`; the
budget is a per-request ceiling, not a per-mode override. If a core journey cannot fit the
default budget, treat that as a signal to split the query, not to relax the limits.

### Compatibility
`X-Rendering-Mode` is an additive, optional request header. Existing clients that omit it keep
the current behavior (`normal`), so no migration is required. Responses and stored schema are
unchanged; the header only influences which optional assets a client requests.
