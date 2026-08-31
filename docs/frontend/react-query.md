# React Query cache conventions

Configured in `src/app/components/providers/QueryProvider.tsx`.

## Defaults

| Option | Value | Rationale |
| --- | --- | --- |
| `staleTime` | `60_000` (60s) | Within a minute, remounts and back-navigation reuse the cache instead of refetching. |
| `gcTime` | `300_000` (5 min) | Inactive data is kept 5 min so back/forward is instant; bounded for long sessions. |
| `refetchOnWindowFocus` | `false` | Focus refetches caused flicker and redundant load. `staleTime` + explicit invalidation keep data fresh. |
| `refetchOnReconnect` | `true` | Cheap, and usually what the user wants after coming back online. |
| `refetchOnMount` | `true` | Refetch on mount only when data is actually stale. |
| `retry` (queries) | up to 2, `0` when offline | Avoids spinning against a disconnected network. |
| `retry` (mutations) | `false` | Most mutation fns are non-idempotent (repayment, remittance); retrying can double-submit. |

### Overriding per query

Opt genuinely live data back into focus refetching locally:

```ts
useQuery({ queryKey: ["pool", "utilisation"], queryFn, refetchOnWindowFocus: true, staleTime: 0 });
```

## Query keys

Array keys, most general segment first:

```
["loans", "list", { status, cursor }]
["loans", "detail", loanId]
["wallet", address, "balances"]
["analytics", "overview", { range }]
```

## Invalidation strategy

Each mutation is responsible for invalidating the keys it affects, in
`onSuccess`:

| Mutation | Invalidate |
| --- | --- |
| Request / extend / refinance loan | `["loans"]` |
| Repay loan | `["loans"]`, `["wallet"]`, `["analytics"]` |
| Send remittance | `["remittances"]`, `["wallet"]` |
| Admin dispute / governance action | the specific `["admin", …]` subtree |
| Mark notifications read | `["notifications"]` |

Prefer the broadest key that is still correct (`["loans"]`) over enumerating
every variation — React Query only refetches the active ones.

## Optimistic updates

Use for small, reversible, single-item changes where the server result is
predictable — e.g. marking a notification read, toggling a setting. Pattern:
`onMutate` cancels in-flight queries + snapshots + writes the optimistic value,
`onError` restores the snapshot, `onSettled` invalidates. Do **not** use
optimistic updates for on-chain actions (loan/repayment/remittance): the outcome
is not known until the transaction settles.
