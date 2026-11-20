"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { useWalletStore } from "../stores/useWalletStore";
import { useUserStore } from "../stores/useUserStore";
import { useGamificationStore } from "../stores/useGamificationStore";
import { useQueryClient } from "@tanstack/react-query";
import { captureSessionIntent, sessionExpiredRedirect } from "../lib/sessionRecovery";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
/** Never let a slow/unreachable API block the user from signing out. */
const LOGOUT_REQUEST_TIMEOUT_MS = 5000;

/**
 * Revoke the JWT server-side (POST /auth/logout adds its jti to the
 * revocation list). Best-effort: local sign-out proceeds even if this fails,
 * and the token still expires on its own.
 */
export async function revokeSession(authToken: string | null): Promise<boolean> {
  if (!authToken) return false;
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), LOGOUT_REQUEST_TIMEOUT_MS) : null;
  try {
    const res = await fetch(`${API_URL}/api/auth/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${authToken}` },
      credentials: "include",
      keepalive: true,
      signal: controller?.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * useLogout
 *
 * Centralised logout handler that:
 *  1. Invalidates the JWT server-side (POST /auth/logout) — skipped when the
 *     session already expired, since the server rejects the token anyway
 *  2. Clears the user store (removes JWT / user data)
 *  3. Disconnects the wallet store
 *  4. Resets the gamification store session state
 *  5. Clears all TanStack Query cache (so stale data doesn't leak between sessions)
 *  6. Redirects to the home / login page
 *
 * Pass `sessionExpired: true` to show an explanatory message before redirect.
 */
export function useLogout() {
  const router = useRouter();
  const queryClient = useQueryClient();

  const clearUser = useUserStore((s) => s.clearUser);
  const disconnectWallet = useWalletStore((s) => s.disconnect);
  const resetGamification = useGamificationStore((s) => s.resetGamification);

  const logout = useCallback(
    async (options?: { sessionExpired?: boolean; redirectTo?: string }) => {
      if (options?.sessionExpired) {
        captureSessionIntent();
      } else {
        // 1. Revoke the token server-side before we forget it locally.
        await revokeSession(useUserStore.getState().authToken);
      }

      // 2. Clear authentication state (JWT, user profile)
      clearUser();

      // 3. Disconnect wallet
      disconnectWallet();

      // 4. Reset gamification session counters
      resetGamification();

      // 5. Purge all cached server data so nothing leaks to the next session
      queryClient.clear();

      // 6. Navigate away
      const dest = options?.redirectTo ?? "/";
      if (options?.sessionExpired) {
        router.replace(dest === "/" ? sessionExpiredRedirect() : `${dest}?reason=session_expired`);
      } else {
        router.replace(dest);
      }
    },
    [clearUser, disconnectWallet, resetGamification, queryClient, router],
  );

  return { logout };
}
