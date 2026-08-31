"use client";

import { useCallback, useEffect, useState } from "react";
import {
  enqueueRequest,
  flushQueue,
  getQueue,
  subscribe,
  type QueuedRequest,
} from "../lib/offlineQueue";

export type SyncStatus = "idle" | "offline" | "syncing" | "synced" | "error";

interface UseOfflineQueueResult {
  isOnline: boolean;
  pending: QueuedRequest[];
  pendingCount: number;
  status: SyncStatus;
  /** Queue a mutating request to be replayed when back online. */
  queue: (entry: Omit<QueuedRequest, "id" | "queuedAt" | "attempts">) => void;
  /** Force a replay attempt now. */
  sync: () => Promise<void>;
}

/**
 * React binding for the offline request queue.
 *
 * - Tracks connectivity and the queued-request list.
 * - Automatically replays the queue when the connection is restored.
 * - Exposes a `status` suitable for an "offline / syncing / synced" indicator.
 */
export function useOfflineQueue(): UseOfflineQueueResult {
  const [isOnline, setIsOnline] = useState(
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  const [pending, setPending] = useState<QueuedRequest[]>([]);
  const [status, setStatus] = useState<SyncStatus>("idle");

  useEffect(() => subscribe(setPending), []);

  const sync = useCallback(async () => {
    if (getQueue().length === 0) return;
    setStatus("syncing");
    const result = await flushQueue();
    if (result.remaining > 0) {
      setStatus("error");
    } else if (result.failed > 0) {
      setStatus("error");
    } else {
      setStatus("synced");
      window.setTimeout(() => setStatus("idle"), 4000);
    }
  }, []);

  useEffect(() => {
    const goOnline = () => {
      setIsOnline(true);
      void sync();
    };
    const goOffline = () => {
      setIsOnline(false);
      setStatus("offline");
    };
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    // Attempt a replay on mount in case requests were queued in a previous session.
    if (navigator.onLine) void sync();
    else setStatus("offline");
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, [sync]);

  const queue = useCallback((entry: Omit<QueuedRequest, "id" | "queuedAt" | "attempts">) => {
    enqueueRequest(entry);
  }, []);

  return {
    isOnline,
    pending,
    pendingCount: pending.length,
    status: !isOnline ? "offline" : status,
    queue,
    sync,
  };
}
