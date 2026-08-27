"use client";

import { useEffect, useMemo, useCallback } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useTranslations } from "next-intl";

interface Shortcut {
  key: string;
  description: string;
  action: () => void;
  category: string;
  keys?: string[];
  preventDefault?: boolean;
}

interface UseKeyboardShortcutsOptions {
  enabled?: boolean;
  scope?: "global" | "local";
}

const MODIFIER_KEYS = ["Control", "Meta", "Alt", "Shift"];

function normalizeKey(key: string): string {
  return key.toLowerCase();
}

function keysMatch(event: KeyboardEvent, shortcutKeys: string[]): boolean {
  const eventKey = normalizeKey(event.key);
  const requiredModifiers = shortcutKeys.filter((k) => MODIFIER_KEYS.includes(k));
  const requiredKey = shortcutKeys.find((k) => !MODIFIER_KEYS.includes(k));

  if (!requiredKey || normalizeKey(requiredKey) !== eventKey) {
    return false;
  }

  for (const modifier of requiredModifiers) {
    const modifierLower = modifier.toLowerCase();
    if (modifierLower === "control" && !event.ctrlKey) return false;
    if (modifierLower === "meta" && !event.metaKey) return false;
    if (modifierLower === "alt" && !event.altKey) return false;
    if (modifierLower === "shift" && !event.shiftKey) return false;
  }

  return true;
}

export function useKeyboardShortcuts(
  shortcuts: Shortcut[],
  options: UseKeyboardShortcutsOptions = {},
): { shortcuts: Shortcut[] } {
  const { enabled = true, scope = "global" } = options;
  const router = useRouter();
  const pathname = usePathname();
  const t = useTranslations("KeyboardShortcuts");

  const memoizedShortcuts = useMemo(() => shortcuts, [shortcuts]);

  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;

      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      ) {
        if (scope === "local") return;
      }

      for (const shortcut of memoizedShortcuts) {
        if (shortcut.keys && keysMatch(event, shortcut.keys)) {
          if (shortcut.preventDefault !== false) {
            event.preventDefault();
          }
          shortcut.action();
          break;
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [enabled, scope, memoizedShortcuts, router, pathname]);

  return { shortcuts: memoizedShortcuts };
}

export function createNavigationShortcuts(
  router: ReturnType<typeof useRouter>,
  locale: string,
): Shortcut[] {
  return [
    {
      key: "g d",
      keys: ["g", "d"],
      description: "Go to Dashboard",
      category: "Navigation",
      action: () => router.push(`/${locale}`),
    },
    {
      key: "g l",
      keys: ["g", "l"],
      description: "Go to Loans",
      category: "Navigation",
      action: () => router.push(`/${locale}/loans`),
    },
    {
      key: "g n",
      keys: ["g", "n"],
      description: "Go to Lend",
      category: "Navigation",
      action: () => router.push(`/${locale}/lend`),
    },
    {
      key: "g a",
      keys: ["g", "a"],
      description: "Go to Analytics",
      category: "Navigation",
      action: () => router.push(`/${locale}/analytics`),
    },
    {
      key: "g w",
      keys: ["g", "w"],
      description: "Go to Wallet",
      category: "Navigation",
      action: () => router.push(`/${locale}/wallet`),
    },
  ];
}

export function createWalletShortcuts(
  connectWallet: () => Promise<void>,
  disconnectWallet: () => void,
  isConnected: boolean,
): Shortcut[] {
  return [
    {
      key: "w",
      keys: ["w"],
      description: isConnected ? "Disconnect Wallet" : "Connect Wallet",
      category: "Wallet",
      action: isConnected ? disconnectWallet : connectWallet,
    },
  ];
}

export function createSearchShortcut(
  openSearch: () => void,
): Shortcut[] {
  return [
    {
      key: "⌘K",
      keys: ["Meta", "k"],
      description: "Open Search",
      category: "Global",
      action: openSearch,
      preventDefault: true,
    },
    {
      key: "Ctrl+K",
      keys: ["Control", "k"],
      description: "Open Search",
      category: "Global",
      action: openSearch,
      preventDefault: true,
    },
  ];
}

export function createGlobalShortcuts(
  toggleTheme: () => void,
  openShortcutsHelp: () => void,
): Shortcut[] {
  return [
    {
      key: "⌘⇧T",
      keys: ["Meta", "Shift", "t"],
      description: "Toggle Theme",
      category: "Global",
      action: toggleTheme,
    },
    {
      key: "Ctrl+Shift+T",
      keys: ["Control", "Shift", "t"],
      description: "Toggle Theme",
      category: "Global",
      action: toggleTheme,
    },
    {
      key: "⌘⇧K",
      keys: ["Meta", "Shift", "k"],
      description: "Show Keyboard Shortcuts",
      category: "Global",
      action: openShortcutsHelp,
    },
    {
      key: "Ctrl+Shift+K",
      keys: ["Control", "Shift", "k"],
      description: "Show Keyboard Shortcuts",
      category: "Global",
      action: openShortcutsHelp,
    },
    {
      key: "?",
      keys: ["?"],
      description: "Show Keyboard Shortcuts",
      category: "Global",
      action: openShortcutsHelp,
    },
  ];
}

export function createContextualShortcuts(
  actions: Record<string, () => void>,
): Shortcut[] {
  const shortcuts: Shortcut[] = [];

  if (actions.refresh) {
    shortcuts.push({
      key: "r",
      keys: ["r"],
      description: "Refresh Data",
      category: "Contextual",
      action: actions.refresh,
    });
  }

  if (actions.newLoan) {
    shortcuts.push({
      key: "n",
      keys: ["n"],
      description: "New Loan",
      category: "Contextual",
      action: actions.newLoan,
    });
  }

  if (actions.deposit) {
    shortcuts.push({
      key: "d",
      keys: ["d"],
      description: "Deposit",
      category: "Contextual",
      action: actions.deposit,
    });
  }

  if (actions.withdraw) {
    shortcuts.push({
      key: "w",
      keys: ["w"],
      description: "Withdraw",
      category: "Contextual",
      action: actions.withdraw,
    });
  }

  return shortcuts;
}