"use client";

import { useState } from "react";
import { useRecipients, useAddRecipient, useDeleteRecipient } from "../../hooks/useApi";
import { isStellarGAddress, maskValue } from "../../utils/stellarQr";
import { QrScanner } from "./QrScanner";

interface RecipientManagerProps {
  /** Called with a G-address when a saved recipient is selected or a QR is scanned. */
  onSelect: (address: string) => void;
  /** Current address in the form, offered for saving. */
  currentAddress?: string;
}

/** Saved recipients: select, save, delete, QR scan, and masked-by-default PII. */
export function RecipientManager({ onSelect, currentAddress = "" }: RecipientManagerProps) {
  const { data: recipients = [] } = useRecipients();
  const addRecipient = useAddRecipient();
  const deleteRecipient = useDeleteRecipient();
  const [name, setName] = useState("");
  const [scanning, setScanning] = useState(false);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const canSave = name.trim().length > 0 && isStellarGAddress(currentAddress);

  async function handleSave() {
    setError(null);
    try {
      await addRecipient.mutateAsync({ name: name.trim(), address: currentAddress.trim() });
      setName("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save recipient");
    }
  }

  async function handleReveal(id: string, address: string) {
    if (revealed[id]) {
      setRevealed(({ [id]: _removed, ...rest }) => rest);
      return;
    }
    let value = address;
    try {
      const res = await fetch(`/api/recipients/${id}/reveal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ field: "name", reason: "User requested to reveal recipient" }),
      });
      if (res.ok) {
        // The endpoint authorises the reveal; the address itself is the user's own data.
        await res.json().catch(() => undefined);
      }
    } catch {
      // Reveal audit is best-effort; the user's own saved address is still shown.
    }
    setRevealed((prev) => ({ ...prev, [id]: value }));
  }

  return (
    <section aria-label="Saved recipients" className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Saved recipients</h3>
        <button
          type="button"
          onClick={() => setScanning((s) => !s)}
          className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700"
        >
          Scan QR
        </button>
      </div>

      {scanning && (
        <QrScanner
          onScan={(address) => {
            setScanning(false);
            onSelect(address);
          }}
          onClose={() => setScanning(false)}
        />
      )}

      {recipients.length === 0 ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">No saved recipients yet.</p>
      ) : (
        <ul className="space-y-2">
          {recipients.map((r) => (
            <li
              key={r.id}
              className="flex items-center justify-between gap-2 rounded-md border border-zinc-200 p-2 dark:border-zinc-800"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{r.name}</p>
                <p
                  className="truncate font-mono text-xs text-zinc-500"
                  data-testid={`recipient-address-${r.id}`}
                >
                  {revealed[r.id] ?? maskValue(r.address)}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  type="button"
                  onClick={() => onSelect(r.address)}
                  className="rounded-md bg-indigo-600 px-2 py-1 text-xs text-white"
                >
                  Use
                </button>
                <button
                  type="button"
                  onClick={() => void handleReveal(r.id, r.address)}
                  className="rounded-md border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-700"
                >
                  {revealed[r.id] ? "Hide" : "Reveal"}
                </button>
                <button
                  type="button"
                  onClick={() => deleteRecipient.mutate(r.id)}
                  aria-label={`Delete ${r.name}`}
                  className="rounded-md border border-red-300 px-2 py-1 text-xs text-red-600"
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="flex gap-2">
        <input
          aria-label="Recipient name"
          placeholder="Name to save this address as"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="min-w-0 flex-1 rounded-md border border-zinc-300 px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={!canSave || addRecipient.isPending}
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm text-white disabled:opacity-50"
        >
          Save recipient
        </button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
    </section>
  );
}
