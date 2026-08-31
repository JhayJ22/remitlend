/**
 * hooks/useToast.ts
 *
 * Backwards-compatible wrapper kept for existing call sites. New code should
 * import `notify` from `@/app/lib/notify` directly.
 *
 * All toasts now route through the single `useToastStore` + `<Toaster />`
 * system so variants, queueing and cross-navigation persistence are consistent
 * app-wide. See docs/frontend/toasts.md.
 */

import { notify, type NotifyOptions } from "../lib/notify";

export interface ToastConfig {
  title?: string;
  description?: string;
  variant?: "default" | "destructive" | "success" | "warning" | "info";
  action?: NotifyOptions["action"];
}

export function useToast() {
  const showToast = (config: ToastConfig) => {
    const title = config.title ?? "";
    const options: NotifyOptions = { description: config.description, action: config.action };
    switch (config.variant) {
      case "destructive":
        return notify.error(title, options);
      case "success":
        return notify.success(title, options);
      case "warning":
        return notify.warning(title, options);
      case "info":
        return notify.info(title, options);
      default:
        return notify.info(title, options);
    }
  };

  return {
    toast: showToast,
    dismiss: notify.dismiss,
  };
}
