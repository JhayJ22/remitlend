"use client";

import { useCallback, useEffect, useState } from "react";
import { useIsMutating, useQueryClient } from "@tanstack/react-query";
import { useUIStore } from "../stores/useUIStore";
import { clearQueue, subscribe as subscribeOfflineQueue } from "../lib/offlineQueue";
import { useLogout } from "./useLogout";

/**
 * useDisconnectWallet
 *
 * Drives the "disconnect wallet" flow so a user never leaves their session in
 * an inconsistent state:
 *
 *  1. `requestDisconnect()` opens a confirmation dialog (`isConfirmOpen`).
 *     While open, `pendingQueueCount` / `inFlightMutationCount` tell the dialog
 *     whether unsent work would be lost so it can warn the user.
 *  2. `confirmDisconnect()`:
 *       - cancels every in-flight query and mutation, then clears the
 *         mutation cache so no late response repopulates the UI;
 *       - discards the offline queue (replaying it after sign-out would send
 *         requests on behalf of a user who has left);
 *       - calls `useLogout`, which revokes the JWT server-side, resets the
 *         user / wallet / gamification stores, clears the query cache and
 *         redirects to `redirectTo` (home by default);
 *       - closes modals and clears toasts.
 *  3. `cancelDisconnect()` just closes the dialog.
 */
export function useDisconnectWallet(redirectTo = "/") {
  const queryClient = useQueryClient();
  const { logout } = useLogout();
  const [isConfirmOpen, setConfirmOpen] = useState(false);
  const [isDisconnecting, setDisconnecting] = useState(false);
  const [pendingQueueCount, setPendingQueueCount] = useState(0);
  const inFlightMutationCount = useIsMutating();

  const closeAllModals = useUIStore((s) => s.closeAllModals);
  const clearToasts = useUIStore((s) => s.clearToasts);

  useEffect(() => subscribeOfflineQueue((queue) => setPendingQueueCount(queue.length)), []);

  const requestDisconnect = useCallback(() => setConfirmOpen(true), []);
  const cancelDisconnect = useCallback(() => {
    if (!isDisconnecting) setConfirmOpen(false);
  }, [isDisconnecting]);

  const confirmDisconnect = useCallback(async () => {
    setDisconnecting(true);
    try {
      // 1. Stop anything in flight so no stale response lands after sign-out.
      await queryClient.cancelQueries();
      queryClient.getMutationCache().clear();

      // 2. Drop queued offline writes; they belong to the session being ended.
      clearQueue();

      // 3. Close transient UI before navigation.
      closeAllModals();
      clearToasts();

      // 4. Revoke JWT server-side, reset stores, clear cache, redirect.
      await logout({ redirectTo });
    } finally {
      setDisconnecting(false);
      setConfirmOpen(false);
    }
  }, [queryClient, closeAllModals, clearToasts, logout, redirectTo]);

  return {
    isConfirmOpen,
    isDisconnecting,
    pendingQueueCount,
    inFlightMutationCount,
    requestDisconnect,
    cancelDisconnect,
    confirmDisconnect,
  };
}
