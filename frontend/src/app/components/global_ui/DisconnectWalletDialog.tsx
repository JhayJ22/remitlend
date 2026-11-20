"use client";

import { AlertTriangle, LogOut } from "lucide-react";
import Modal from "../ui/Modal";
import { Button } from "../ui/Button";

interface DisconnectWalletDialogProps {
  isOpen: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  /** Offline-queued writes that will be discarded on disconnect. */
  pendingQueueCount?: number;
  /** Mutations currently in flight that will be cancelled on disconnect. */
  inFlightMutationCount?: number;
  /** True while cleanup (incl. server-side logout) is running. */
  isDisconnecting?: boolean;
}

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Confirmation dialog shown before disconnecting the wallet.
 *
 * Pair with `useDisconnectWallet`, which owns the open state, reports pending
 * work, and performs the cancel / queue-discard / logout / redirect cleanup
 * when the user confirms.
 */
export function DisconnectWalletDialog({
  isOpen,
  onCancel,
  onConfirm,
  pendingQueueCount = 0,
  inFlightMutationCount = 0,
  isDisconnecting = false,
}: DisconnectWalletDialogProps) {
  const hasPendingWork = pendingQueueCount > 0 || inFlightMutationCount > 0;

  return (
    <Modal isOpen={isOpen} onClose={onCancel} title="Disconnect wallet?" size="sm">
      <div className="space-y-4" data-testid="disconnect-wallet-dialog">
        {hasPendingWork && (
          <div
            role="alert"
            data-testid="disconnect-pending-warning"
            className="flex items-start gap-3 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" aria-hidden="true" />
            <div className="text-sm text-zinc-700 dark:text-zinc-200">
              <p className="font-medium">You have unsent activity.</p>
              <ul className="mt-1 list-disc pl-4">
                {pendingQueueCount > 0 && (
                  <li>
                    {plural(pendingQueueCount, "offline action", "offline actions")} waiting to sync
                    will be discarded.
                  </li>
                )}
                {inFlightMutationCount > 0 && (
                  <li>
                    {plural(inFlightMutationCount, "request", "requests")} in progress will be
                    cancelled.
                  </li>
                )}
              </ul>
            </div>
          </div>
        )}

        <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3">
          <LogOut className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" aria-hidden="true" />
          <p className="text-sm text-zinc-600 dark:text-zinc-300">
            You&apos;ll be signed out and pending requests cancelled, then returned to the home
            page. Your funds and on-chain activity are not affected.
          </p>
        </div>

        <div className="flex justify-end gap-3">
          <Button variant="secondary" onClick={onCancel} disabled={isDisconnecting}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={onConfirm}
            disabled={isDisconnecting}
            data-testid="confirm-disconnect"
          >
            {isDisconnecting
              ? "Disconnecting…"
              : hasPendingWork
                ? "Discard and disconnect"
                : "Disconnect"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
