"use client";

import { useEffect, useState, useRef } from "react";
import { X, Keyboard, Command } from "lucide-react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/utils";

interface KeyboardShortcutsHelpProps {
  isOpen: boolean;
  onClose: () => void;
  shortcuts: Array<{
    key: string;
    description: string;
    category: string;
    keys?: string[];
  }>;
}

const CATEGORY_ORDER = ["Global", "Navigation", "Wallet", "Contextual", "Custom"];

function formatKey(key: string): React.ReactNode {
  if (key.includes("+") || key.includes(" ")) {
    return key.split(/[\s+]+/).map((k) => (
      <kbd key={k} className="px-1.5 py-0.5 text-xs font-mono rounded bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700">
        {k === "Meta" ? <Command className="h-3 w-3" /> : k.toUpperCase()}
      </kbd>
    ));
  }
  return (
    <kbd className="px-1.5 py-0.5 text-xs font-mono rounded bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700">
      {key.toUpperCase()}
    </kbd>
  );
}

export function KeyboardShortcutsHelp({
  isOpen,
  onClose,
  shortcuts,
}: KeyboardShortcutsHelpProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const previousActiveElement = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (isOpen) {
      previousActiveElement.current = document.activeElement as HTMLElement;
      dialogRef.current?.showModal();
      document.body.style.overflow = "hidden";
    } else {
      dialogRef.current?.close();
      document.body.style.overflow = "";
      previousActiveElement.current?.focus();
    }

    return () => {
      document.body.style.overflow = "";
    };
  }, [isOpen]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  if (!isOpen) return null;

  const filteredShortcuts = shortcuts.filter((s) =>
    s.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
    s.key.toLowerCase().includes(searchQuery.toLowerCase()) ||
    s.category.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  const groupedShortcuts = filteredShortcuts.reduce(
    (acc, shortcut) => {
      const category = shortcut.category || "Custom";
      if (!acc[category]) acc[category] = [];
      acc[category].push(shortcut);
      return acc;
    },
    {} as Record<string, typeof shortcuts>,
  );

  const sortedCategories = Object.keys(groupedShortcuts).sort((a, b) => {
    const indexA = CATEGORY_ORDER.indexOf(a);
    const indexB = CATEGORY_ORDER.indexOf(b);
    if (indexA === -1 && indexB === -1) return a.localeCompare(b);
    if (indexA === -1) return 1;
    if (indexB === -1) return -1;
    return indexA - indexB;
  });

  return createPortal(
    <dialog
      ref={dialogRef}
      className="relative w-full max-w-2xl rounded-2xl border border-zinc-200 bg-white p-6 shadow-xl dark:border-zinc-800 dark:bg-zinc-950"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-100 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-400">
            <Keyboard className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">Keyboard Shortcuts</h2>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              Press <kbd className="px-1.5 py-0.5 text-xs font-mono rounded bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700">?</kbd> or <kbd className="px-1.5 py-0.5 text-xs font-mono rounded bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700">⌘</kbd><kbd className="px-1.5 py-0.5 text-xs font-mono rounded bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700">⇧</kbd><kbd className="px-1.5 py-0.5 text-xs font-mono rounded bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700">K</kbd> to open this dialog
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1 text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
          aria-label="Close keyboard shortcuts help"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="mt-4 flex gap-2">
        <span className="flex items-center gap-1.5 text-sm text-zinc-500 dark:text-zinc-400">
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </span>
        <input
          type="search"
          placeholder="Search shortcuts..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="flex-1 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-50"
          autoFocus
        />
      </div>

      <div className="mt-6 max-h-[50vh] overflow-y-auto space-y-4">
        {sortedCategories.length === 0 ? (
          <p className="text-center text-zinc-500 dark:text-zinc-400 py-8">
            No shortcuts found matching "{searchQuery}"
          </p>
        ) : (
          sortedCategories.map((category) => (
            <div key={category} className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                {category}
              </h3>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
                {groupedShortcuts[category].map((shortcut) => (
                  <React.Fragment key={shortcut.description}>
                    <dt className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
                      {formatKey(shortcut.key)}
                    </dt>
                    <dd className="text-sm text-zinc-600 dark:text-zinc-400">
                      {shortcut.description}
                    </dd>
                  </React.Fragment>
                ))}
              </dl>
            </div>
          ))
        )}
      </div>

      <div className="mt-6 pt-4 border-t border-zinc-200 dark:border-zinc-800">
        <p className="text-xs text-zinc-500 dark:text-zinc-400 text-center">
          Shortcuts work globally unless an input field is focused. Press <kbd className="px-1.5 py-0.5 text-xs font-mono rounded bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700">Esc</kbd> to close this dialog.
        </p>
      </div>
    </dialog>,
    document.body,
  );
}