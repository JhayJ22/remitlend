"use client";

import { LogOut } from "lucide-react";
import Modal from "../ui/Modal";
import { Button } from "../ui/Button";

interface DisconnectWalletDialogProps {
  isOpen: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Confirmation dialog shown before disconnecting the wallet.
 *
 * Pair with `useDisconnectWallet`, which owns the open state and performs the
 * cache-cancel / store-reset / redirect work when the user confirms.
 */
export function DisconnectWalletDialog({
  isOpen,
  onCancel,
  onConfirm,
}: DisconnectWalletDialogProps) {
  return (
    <Modal isOpen={isOpen} onClose={onCancel} title="Disconnect wallet?" size="sm">
      <div className="space-y-4">
        <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3">
          <LogOut className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" aria-hidden="true" />
          <p className="text-sm text-zinc-600 dark:text-zinc-300">
            You&apos;ll be signed out and pending requests cancelled, then returned to the
            home page. Your funds and on-chain activity are not affected.
          </p>
        </div>

        <div className="flex justify-end gap-3">
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm}>
            Disconnect
          </Button>
        </div>
      </div>
    </Modal>
  );
}
