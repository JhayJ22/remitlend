import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type TransactionPreviewStatus =
  | "loading"
  | "ready"
  | "changed"
  | "error"
  | "expired";

export interface TransactionPreviewField {
  key: string;
  label: string;
  value: string;
}

export interface TransactionPreview {
  network: string;
  recipient: string;
  fees: string;
  expiry: string;
  changedFields: TransactionPreviewField[];
}

export interface TransactionPreviewAnnouncement {
  /** Ordered, screen-reader friendly sentences for the preview. */
  messages: string[];
  /** Polite vs assertive live-region politeness. */
  politeness: "polite" | "assertive";
}

export interface UseTransactionPreviewOptions {
  /** Fetches the authoritative preview for the current draft. */
  loadPreview: () => Promise<TransactionPreview>;
  /** Milliseconds before a ready preview is considered stale. */
  expiryMs?: number;
  /** Optional clock injection for deterministic tests. */
  now?: () => number;
}

export interface UseTransactionPreviewResult {
  status: TransactionPreviewStatus;
  preview: TransactionPreview | null;
  error: string | null;
  announcement: TransactionPreviewAnnouncement;
  /** True when the preview can be confirmed without a stale/expired rejection. */
  canConfirm: boolean;
  /** Rejects stale/expired confirmations without partial side effects. */
  confirm: () => boolean;
  /** Re-runs the preview load, clearing any prior error/expiry. */
  reload: () => void;
}

const DEFAULT_EXPIRY_MS = 5 * 60 * 1000;

function buildAnnouncement(
  status: TransactionPreviewStatus,
  preview: TransactionPreview | null,
  error: string | null,
): TransactionPreviewAnnouncement {
  if (status === "loading") {
    return { messages: ["Loading transaction preview."], politeness: "polite" };
  }

  if (status === "error") {
    return {
      messages: [error ?? "Transaction preview could not be loaded."],
      politeness: "assertive",
    };
  }

  if (status === "expired") {
    return {
      messages: [
        "Transaction preview expired. Reload the preview before confirming.",
      ],
      politeness: "assertive",
    };
  }

  if (!preview) {
    return { messages: [], politeness: "polite" };
  }

  const messages = [
    `Network: ${preview.network}.`,
    `Recipient: ${preview.recipient}.`,
    `Fees: ${preview.fees}.`,
    `Expiry: ${preview.expiry}.`,
  ];

  if (preview.changedFields.length > 0) {
    const changed = preview.changedFields
      .map((field) => `${field.label}: ${field.value}`)
      .join("; ");
    messages.push(`Changed fields: ${changed}.`);
  }

  if (status === "changed") {
    messages.push("Preview updated. Review the changed fields before confirming.");
  }

  return { messages, politeness: "polite" };
}

export function useTransactionPreview(
  options: UseTransactionPreviewOptions,
): UseTransactionPreviewResult {
  const { loadPreview, expiryMs = DEFAULT_EXPIRY_MS, now = Date.now } = options;

  const [status, setStatus] = useState<TransactionPreviewStatus>("loading");
  const [preview, setPreview] = useState<TransactionPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const loadedAtRef = useRef<number | null>(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    let cancelled = false;

    setStatus("loading");
    setError(null);

    loadPreview()
      .then((result) => {
        if (cancelled || requestId !== requestIdRef.current) {
          return;
        }
        loadedAtRef.current = now();
        setPreview(result);
        setStatus(result.changedFields.length > 0 ? "changed" : "ready");
      })
      .catch((err: unknown) => {
        if (cancelled || requestId !== requestIdRef.current) {
          return;
        }
        loadedAtRef.current = null;
        setPreview(null);
        setError(
          err instanceof Error && err.message
            ? err.message
            : "Transaction preview could not be loaded.",
        );
        setStatus("error");
      });

    return () => {
      cancelled = true;
    };
  }, [loadPreview, now, reloadToken]);

  const isExpired = useCallback(() => {
    if (loadedAtRef.current === null) {
      return true;
    }
    return now() - loadedAtRef.current >= expiryMs;
  }, [expiryMs, now]);

  const confirm = useCallback(() => {
    if (status === "loading" || status === "error") {
      return false;
    }
    if (isExpired()) {
      setStatus("expired");
      return false;
    }
    return true;
  }, [isExpired, status]);

  const reload = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  const announcement = useMemo(
    () => buildAnnouncement(status, preview, error),
    [status, preview, error],
  );

  const canConfirm = status === "ready" || status === "changed";

  return {
    status,
    preview,
    error,
    announcement,
    canConfirm,
    confirm,
    reload,
  };
}
