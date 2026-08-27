"use client";

import React, { useEffect, useRef } from "react";
import { useWalletStore } from "../stores/useWalletStore";
import { useToastStore } from "../stores/useToastStore";

/**
 * Hook that listens to wallet store changes and shows toast notifications.
 * Provides user feedback for wallet connection state changes, network switches, etc.
 */
export function useWalletToasts() {
  const status = useWalletStore((state) => state.status);
  const address = useWalletStore((state) => state.address);
  const network = useWalletStore((state) => state.network);
  const error = useWalletStore((state) => state.error);
  const shouldAutoReconnect = useWalletStore((state) => state.shouldAutoReconnect);

  const { addToast, dismissToast } = useToastStore();

  // Track previous values to detect changes
  const prevStatusRef = useRef(status);
  const prevAddressRef = useRef(address);
  const prevNetworkRef = useRef(network);
  const toastIdRef = useRef<string | null>(null);

  useEffect(() => {
    // Status changes
    if (prevStatusRef.current !== status) {
      const prevStatus = prevStatusRef.current;
      prevStatusRef.current = status;

      switch (status) {
        case "connecting":
          toastIdRef.current = addToast({
            type: "info",
            title: "Connecting wallet...",
            description: "Please approve the connection in Freighter",
            duration: 0, // Persistent until updated
          });
          break;

        case "connected":
          // Dismiss connecting toast
          if (toastIdRef.current) {
            dismissToast(toastIdRef.current);
            toastIdRef.current = null;
          }
          if (prevStatus === "connecting" || prevStatus === "disconnected") {
            addToast({
              type: "success",
              title: "Wallet connected",
              description: address ? `Connected as ${address.slice(0, 6)}...${address.slice(-4)}` : "Ready to use",
              duration: 4000,
            });
          } else if (prevStatus === "error") {
            addToast({
              type: "success",
              title: "Wallet reconnected",
              description: "Connection restored successfully",
              duration: 4000,
            });
          }
          break;

        case "disconnected":
          // Dismiss any pending toast
          if (toastIdRef.current) {
            dismissToast(toastIdRef.current);
            toastIdRef.current = null;
          }
          if (prevStatus === "connected") {
            addToast({
              type: "info",
              title: "Wallet disconnected",
              description: "Reconnect anytime to continue borrowing and lending",
              duration: 4000,
            });
          }
          break;

        case "error":
          if (toastIdRef.current) {
            dismissToast(toastIdRef.current);
            toastIdRef.current = null;
          }
          if (error) {
            addToast({
              type: "error",
              title: "Wallet error",
              description: error,
              duration: 10000,
            });
          }
          break;
      }
    }
  }, [status, address, error, addToast, dismissToast]);

  // Address changes (account switch in wallet)
  useEffect(() => {
    if (prevAddressRef.current !== address && address && prevAddressRef.current) {
      prevAddressRef.current = address;
      addToast({
        type: "info",
        title: "Account changed",
        description: `Switched to ${address.slice(0, 6)}...${address.slice(-4)}`,
        duration: 4000,
      });
    } else if (address) {
      prevAddressRef.current = address;
    }
  }, [address, addToast]);

  // Network changes
  useEffect(() => {
    if (prevNetworkRef.current !== network && network && prevNetworkRef.current) {
      const prevNetwork = prevNetworkRef.current;
      prevNetworkRef.current = network;

      if (prevNetwork?.name !== network.name) {
        addToast({
          type: network.isSupported ? "info" : "warning",
          title: "Network changed",
          description: network.isSupported
            ? `Switched to ${network.name}`
            : `Unsupported network: ${network.name}. Switch to PUBLIC, TESTNET, FUTURENET, or STANDALONE.`,
          duration: network.isSupported ? 4000 : 10000,
        });
      }
    } else if (network) {
      prevNetworkRef.current = network;
    }
  }, [network, addToast]);

  // Auto-reconnect toast
  useEffect(() => {
    if (shouldAutoReconnect && status === "disconnected" && address) {
      addToast({
        type: "info",
        title: "Auto-reconnecting wallet...",
        description: "Restoring your previous session",
        duration: 3000,
      });
    }
  }, [shouldAutoReconnect, status, address, addToast]);
}