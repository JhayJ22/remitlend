"use client";

import { useEffect, useState } from "react";
import { Download, Share, X } from "lucide-react";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DISMISS_KEY = "remitlend-pwa-install-dismissed";
const DISMISS_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days

function recentlyDismissed(): boolean {
  try {
    const raw = window.localStorage.getItem(DISMISS_KEY);
    if (!raw) return false;
    return Date.now() - Number(raw) < DISMISS_TTL_MS;
  } catch {
    return false;
  }
}

function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    // iOS Safari
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

function isIos(): boolean {
  return /iphone|ipad|ipod/i.test(window.navigator.userAgent);
}

/**
 * Cross-platform "Add to Home Screen" banner.
 *
 * - Chromium/Android/desktop: captures `beforeinstallprompt` and drives the
 *   native install flow.
 * - iOS Safari (which never fires that event): shows manual Share-sheet steps.
 *
 * Dismissal is remembered for two weeks so the banner is not nagging.
 */
export function PWAInstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [visible, setVisible] = useState(false);
  const [iosHint, setIosHint] = useState(false);

  useEffect(() => {
    if (isStandalone() || recentlyDismissed()) return;

    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setDeferredPrompt(event as BeforeInstallPromptEvent);
      setVisible(true);
    };

    const onInstalled = () => {
      setVisible(false);
      setDeferredPrompt(null);
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onInstalled);

    // iOS gets no event — surface the manual hint after a short delay.
    let iosTimer: ReturnType<typeof setTimeout> | undefined;
    if (isIos()) {
      iosTimer = setTimeout(() => {
        setIosHint(true);
        setVisible(true);
      }, 3000);
    }

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onInstalled);
      if (iosTimer) clearTimeout(iosTimer);
    };
  }, []);

  const dismiss = () => {
    setVisible(false);
    try {
      window.localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {
      /* storage unavailable — dismiss for this session only */
    }
  };

  const install = async () => {
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === "accepted") {
      setVisible(false);
    }
    setDeferredPrompt(null);
  };

  if (!visible) return null;

  return (
    <div
      role="dialog"
      aria-label="Install RemitLend"
      className="fixed inset-x-3 bottom-3 z-50 mx-auto max-w-md rounded-2xl border border-zinc-200 bg-white p-4 shadow-xl dark:border-zinc-800 dark:bg-zinc-900 lg:left-auto lg:right-6"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-indigo-50 dark:bg-indigo-500/10">
          <Download className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
        </div>
        <div className="flex-1">
          <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
            Install RemitLend
          </p>
          {iosHint ? (
            <p className="mt-1 flex items-center gap-1 text-xs text-zinc-500 dark:text-zinc-400">
              Tap <Share className="inline h-3.5 w-3.5" /> then “Add to Home Screen”.
            </p>
          ) : (
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              Add the app to your home screen for faster access and offline support.
            </p>
          )}
          {!iosHint && (
            <button
              type="button"
              onClick={install}
              className="mt-3 inline-flex items-center gap-2 rounded-full bg-indigo-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-indigo-700"
            >
              <Download className="h-4 w-4" />
              Add to Home Screen
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss install prompt"
          className="rounded-full p-1 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
