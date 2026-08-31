# URL state conventions

Filters, tabs, analytics time ranges and pagination are stored in the URL query
string so that:

- state survives a page refresh,
- a filtered view can be copied from the address bar and shared,
- browser back/forward moves between filter states.

## API

Use the helpers in `src/app/hooks/useUrlState.ts`. They are shaped like
[`nuqs`](https://nuqs.47ng.com/) so a later swap is mechanical, but carry no
dependency — the App Router's `useSearchParams` + `useRouter` cover what we need.

```ts
import {
  useUrlStates,
  enumParam,
  numberParam,
  stringParam,
  booleanParam,
} from "@/app/hooks/useUrlState";

const [{ status, page }, setState] = useUrlStates({
  status: enumParam(["all", "active", "repaid", "defaulted"] as const, "all"),
  page: numberParam(1),
});

// changing a filter also resets pagination — one navigation
setState({ status: "active", page: 1 });
```

`useUrlState(key, parser)` is the single-param version and returns a
`[value, setValue]` tuple.

## Rules

| Rule | Why |
| --- | --- |
| A param equal to its default is **omitted** from the URL. | Keeps shared URLs short; `/loans` and `/loans?status=all` are identical. |
| Writes use `router.replace` + `scroll: false` by default. | Typing in a filter should not spam history or jump the page. |
| Pass `{ history: "push" }` for changes that deserve a back-button stop. | e.g. opening a detail view via a query param. |
| Never mirror the parsed value into `useState`. | `useSearchParams` re-renders on `popstate`, so derived state is already back/forward-correct. |
| Param keys are `lowerCamelCase` or single words: `status`, `page`, `range`, `q`. | Consistency across pages. |
| Parsers validate: unknown enum values / non-numeric pages fall back to the default. | A hand-edited or stale URL never crashes the page. |

## Client component / Suspense

`useSearchParams` opts a route into client rendering. Wrap the client subtree in
`<Suspense>` in the `page.tsx` (see `src/app/[locale]/loans/page.tsx`) so the
rest of the route can still stream.

## Reference implementation

`src/app/[locale]/loans/LoansPageClient.tsx` — `?status=` + `?page=`.
