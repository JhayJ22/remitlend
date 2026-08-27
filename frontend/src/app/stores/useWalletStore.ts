/**
 * stores/useWalletStore.ts
 *
 * Zustand store for Web3 wallet connection state.
 *
 * Responsibilities:
 *  - Track the connected wallet address
 *  - Track the current chain / network
 *  - Track available token balances
 *  - Provide actions to connect / disconnect
 *
 * Design decision: actual wallet provider interaction (ethers / wagmi calls)
 * lives in a separate hook or service. This store is the single source of truth
 * for the resulting state so any component can read it without a provider tree.
 */

import { create } from "zustand";
import { createJSONStorage, devtools, persist } from "zustand/middleware";
import type { QueryClient } from "@tanstack/react-query";

// ─── Types ───────────────────────────────────────────────────────────────────

export type WalletStatus = "disconnected" | "connecting" | "connected" | "error";

export interface TokenBalance {
  symbol: string;
  /** Human-readable amount, e.g. "1.234" */
  amount: string;
  /** USD value, or null if price unavailable */
  usdValue: number | null;
}

export interface WalletNetwork {
  chainId: number;
  name: string;
  /** Whether this is one of the app's supported networks */
  isSupported: boolean;
}

interface WalletState {
  /** Wallet connection status */
  status: WalletStatus;
  /** Connected wallet address (checksummed) — null when disconnected */
  address: string | null;
  /** Current network info */
  network: WalletNetwork | null;
  /** Token balances for the connected wallet */
  balances: TokenBalance[];
  /** True while fetching/refreshing balances */
  isLoadingBalances: boolean;
  /** Human-readable error message */
  error: string | null;
  /** Whether the app should try to restore the wallet on refresh */
  shouldAutoReconnect: boolean;
  /** Query client for cancelling pending requests on disconnect */
  queryClient: QueryClient | null;
}

interface WalletActions {
  /** Call after a successful wallet.connect() to store the result */
  setConnected: (address: string, network: WalletNetwork) => void;
  /** Call on disconnect or user-initiated Sign Out with wallet */
  disconnect: () => void;
  /** Enhanced disconnect that also cancels pending queries and clears cache */
  disconnectAndCleanup: () => void;
  /** Set the query client for cancelling pending requests */
  setQueryClient: (client: QueryClient) => void;
  /** Update balances after fetching from the chain */
  setBalances: (balances: TokenBalance[]) => void;
  /** Update network when the user switches chains */
  setNetwork: (network: WalletNetwork) => void;
  setStatus: (status: WalletStatus) => void;
  setError: (error: string | null, status?: WalletStatus) => void;
  setLoadingBalances: (loading: boolean) => void;
}

export type WalletStore = WalletState & WalletActions;

// ─── Initial state ────────────────────────────────────────────────────────────

const initialState: WalletState = {
  status: "disconnected",
  address: null,
  network: null,
  balances: [],
  isLoadingBalances: false,
  error: null,
  shouldAutoReconnect: false,
  queryClient: null,
};

// ─── Store ────────────────────────────────────────────────────────────────────

export const useWalletStore = create<WalletStore>()(
  devtools(
    persist(
      (set, get) => ({
        ...initialState,

        setConnected: (address, network) =>
          set(
            {
              status: "connected",
              address,
              network,
              error: null,
              shouldAutoReconnect: true,
            },
            false,
            "wallet/setConnected",
          ),

        disconnect: () =>
          set(
            {
              ...initialState,
            },
            false,
            "wallet/disconnect",
          ),

        disconnectAndCleanup: () => {
          const { queryClient } = get();
          
          // Cancel all pending queries and mutations
          if (queryClient) {
            queryClient.cancelQueries({});
            queryClient.cancelMutations();
            // Clear query cache for wallet-specific data
            queryClient.removeQueries({ queryKey: ["loans"] });
            queryClient.removeQueries({ queryKey: ["remittances"] });
            queryClient.removeQueries({ queryKey: ["pool"] });
            queryClient.removeQueries({ queryKey: ["scoreBreakdown"] });
            queryClient.removeQueries({ queryKey: ["creditScore"] });
            queryClient.removeQueries({ queryKey: ["yieldHistory"] });
            queryClient.removeQueries({ queryKey: ["remittanceNft"] });
            queryClient.removeQueries({ queryKey: ["notifications"] });
            queryClient.removeQueries({ queryKey: ["notificationPreferences"] });
            queryClient.removeQueries({ queryKey: ["user"] });
          }
          
          // Reset to initial state
          set(
            {
              ...initialState,
            },
            false,
            "wallet/disconnectAndCleanup",
          );
        },

        setQueryClient: (client: QueryClient) =>
          set({ queryClient: client }, false, "wallet/setQueryClient"),

        setBalances: (balances) =>
          set({ balances, isLoadingBalances: false }, false, "wallet/setBalances"),

        setNetwork: (network) => set({ network }, false, "wallet/setNetwork"),

        setStatus: (status) => set({ status }, false, "wallet/setStatus"),

        setError: (error, status = "error") =>
          set({ error, status, isLoadingBalances: false }, false, "wallet/setError"),

        setLoadingBalances: (isLoadingBalances) =>
          set({ isLoadingBalances }, false, "wallet/setLoadingBalances"),
      }),
      {
        name: "remitlend-wallet",
        storage: createJSONStorage(() => localStorage),
        partialize: (state) => ({
          status: state.status,
          address: state.address,
          network: state.network,
          balances: state.balances,
          shouldAutoReconnect: state.shouldAutoReconnect,
        }),
      },
    ),
    { name: "WalletStore" },
  ),
);

// ─── Selectors ────────────────────────────────────────────────────────────────

export const selectWalletAddress = (state: WalletStore) => state.address;
export const selectWalletStatus = (state: WalletStore) => state.status;
export const selectIsWalletConnected = (state: WalletStore) => state.status === "connected";
export const selectWalletNetwork = (state: WalletStore) => state.network;
export const selectWalletBalances = (state: WalletStore) => state.balances;
export const selectWalletError = (state: WalletStore) => state.error;
export const selectWalletShouldAutoReconnect = (state: WalletStore) => state.shouldAutoReconnect;
