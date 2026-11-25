"use client";

import { QRCodeSVG } from "qrcode.react";
import { useWalletStore, selectWalletAddress } from "../../stores/useWalletStore";

/** Shows the connected wallet's own address as a QR code so others can scan it. */
export function MyAddressQr() {
  const address = useWalletStore(selectWalletAddress);
  if (!address) return null;
  return (
    <div className="flex items-center gap-4 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <div className="rounded bg-white p-2">
        <QRCodeSVG value={address} size={96} aria-label="Your wallet address QR code" />
      </div>
      <div className="min-w-0">
        <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Your address</p>
        <p className="break-all font-mono text-xs text-zinc-500 dark:text-zinc-400">{address}</p>
      </div>
    </div>
  );
}
