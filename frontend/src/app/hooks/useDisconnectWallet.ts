"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useWalletStore } from "../stores/useWalletStore";
import { useUserStore } from "../stores/useUserStore";
import { useGamificationStore } from "../stores/useGamificationStore";
import { useUIStore } from "../stores/useUIStore";

/**
 * useDisconnectWallet
 *
 * Drives the "disconnect wallet" flow so a user never ends up looking at stale,
 * half-authenticated UI:
 *
 *  1. `requestDisconnect()` opens a confirmation dialog (`isConfirmOpen`).
 *  2. `confirmDisconnect()`:
 *       - cancels every in-flight query and mutation, then clears the cache so
 *         no late response repopulates the UI after we've signed out;
 *       - resets all client stores (wallet, user, gamification, UI) to their
 *         initial state;
 *       - redirects to the home page.
 *  3. `cancelDisconnect()` just closes the dialog.
 *
 * Wrap the returned `isConfirmOpen` / `confirmDisconnect` / `cancelDisconnect`
 * with `<DisconnectWalletDialog />`.
 */
export function useDisconnectWallet(redirectTo = "/") {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [isConfirmOpen, setConfirmOpen] = useState(false);

  const disconnectWallet = useWalletStore((s) => s.disconnect);
  const clearUser = useUserStore((s) => s.clearUser);
  const resetGamification = useGamificationStore((s) => s.resetGamification);
  const closeAllModals = useUIStore((s) => s.closeAllModals);
  const clearToasts = useUIStore((s) => s.clearToasts);

  const requestDisconnect = useCallback(() => setConfirmOpen(true), []);
  const cancelDisconnect = useCallback(() => setConfirmOpen(false), []);

  const confirmDisconnect = useCallback(async () => {
    // 1. Stop anything in flight so no stale response lands after sign-out.
    await queryClient.cancelQueries();
    queryClient.getMutationCache().clear();
    queryClient.clear();

    // 2. Reset every client store to a clean, logged-out state.
    disconnectWallet();
    clearUser();
    resetGamification();
    closeAllModals();
    clearToasts();

    // 3. Leave the user on a clean home screen.
    setConfirmOpen(false);
    router.replace(redirectTo);
  }, [
    queryClient,
    disconnectWallet,
    clearUser,
    resetGamification,
    closeAllModals,
    clearToasts,
    router,
    redirectTo,
  ]);

  return { isConfirmOpen, requestDisconnect, cancelDisconnect, confirmDisconnect };
}
