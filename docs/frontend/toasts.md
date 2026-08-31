# Toast notifications

There is **one** toast system: the `useToastStore` (Zustand) + `<Toaster />`
component, mounted once in `src/app/layout.tsx`. Do not add `sonner` /
`react-hot-toast` `<Toaster>` instances — they were removed to stop
inconsistent styling and double toasts.

## Usage

```ts
import { notify, withToast } from "@/app/lib/notify";

notify.success("Repayment submitted");
notify.error("Could not load loans", {
  description: err.message,
  action: { label: "Retry", onClick: () => refetch() },
});
notify.warning("Your session expires in 2 minutes", { critical: true });
notify.info("Syncing wallet…");
```

`withToast` wraps a mutation and handles the pending / success / error toasts,
including a working **Retry** button on failure:

```ts
await withToast(() => repayLoan(id), {
  pending: "Submitting repayment…",
  success: "Repayment submitted",
  error: "Repayment failed",
});
```

The legacy `useToast()` hook still works and now routes through the same store.

## Behaviour

| Concern | Behaviour |
| --- | --- |
| Queue | Max **3** visible at once, max **20** retained (`useToastStore`). Toasts never stack infinitely. |
| Variants | `success` / `error` / `warning` / `info`, each with its own colour + icon. |
| Auto-dismiss | 5s default, 10s for errors. `critical: true` or `duration: 0` = stays until dismissed. |
| Actions | One action button per toast (`Retry`, `View`, …). The close (X) button is always present. |
| Navigation | The store is app-root scoped, so toasts — especially `critical` ones — persist across client-side route changes until dismissed. |
| Transaction toasts | Pass `txHash` + `explorerUrl` (see `useContractToast`) to render a "View transaction" link. |

## When to toast

- **Every mutation** (loan request, repayment, remittance, admin action) shows a
  success or error toast. Use `withToast` or `useContractMutation`.
- Background/async operations the user cannot see (wallet sync, cache refresh)
  toast only on failure or on a state change the user should know about.
- Never toast for validation errors that are already shown inline on a field.
