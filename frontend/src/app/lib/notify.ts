/**
 * lib/notify.ts
 *
 * The single entry point for toast notifications in the app.
 *
 * Everything renders through `useToastStore` + `<Toaster />` (mounted once in
 * the root layout), which gives us for free:
 *  - a queue: at most 3 toasts are visible, up to 20 are retained, so toasts
 *    never "stack infinitely";
 *  - variants: success | error | warning | info;
 *  - an optional action button (Retry / View / …);
 *  - persistence across client-side navigation, because the store lives at the
 *    app root and is not tied to any route.
 *
 * See docs/frontend/toasts.md for usage conventions.
 */

import { useToastStore, type ToastType } from "../stores/useToastStore";

export interface NotifyOptions {
  description?: string;
  /** Primary action button, e.g. `{ label: "Retry", onClick: () => mutate() }`. */
  action?: { label: string; onClick: () => void };
  /**
   * Critical toasts stay until dismissed (no auto-timeout) and therefore
   * survive navigation until the user acknowledges them.
   */
  critical?: boolean;
  /** Explicit duration in ms. Overrides `critical`. `0` = never auto-dismiss. */
  duration?: number;
  /** Provide a stable id to de-dupe / later `update()` the same toast. */
  id?: string;
}

function push(type: ToastType, title: string, options: NotifyOptions = {}): string {
  const duration = options.duration ?? (options.critical ? 0 : undefined);
  return useToastStore.getState().addToast({
    id: options.id,
    type,
    title,
    description: options.description,
    action: options.action,
    ...(duration !== undefined ? { duration } : {}),
  });
}

export const notify = {
  success: (title: string, options?: NotifyOptions) => push("success", title, options),
  error: (title: string, options?: NotifyOptions) => push("error", title, options),
  warning: (title: string, options?: NotifyOptions) => push("warning", title, options),
  info: (title: string, options?: NotifyOptions) => push("info", title, options),
  dismiss: (id: string) => useToastStore.getState().dismissToast(id),
  update: useToastStore.getState().updateToast,
  /** Clear everything — use sparingly (e.g. on logout). */
  clear: () => useToastStore.getState().clearToasts(),
};

/**
 * Wrap an async mutation so failures surface a toast with a working "Retry"
 * button and successes surface a confirmation. Returns the mutation result.
 *
 * @example
 * await withToast(() => repayLoan(id), {
 *   pending: "Submitting repayment…",
 *   success: "Repayment submitted",
 *   error: "Repayment failed",
 * });
 */
export async function withToast<T>(
  run: () => Promise<T>,
  messages: { pending?: string; success: string; error: string },
): Promise<T> {
  const pendingId = messages.pending
    ? notify.info(messages.pending, { duration: 0 })
    : undefined;
  try {
    const result = await run();
    if (pendingId) notify.dismiss(pendingId);
    notify.success(messages.success);
    return result;
  } catch (cause) {
    if (pendingId) notify.dismiss(pendingId);
    notify.error(messages.error, {
      description: cause instanceof Error ? cause.message : undefined,
      critical: true,
      action: { label: "Retry", onClick: () => void withToast(run, messages) },
    });
    throw cause;
  }
}
