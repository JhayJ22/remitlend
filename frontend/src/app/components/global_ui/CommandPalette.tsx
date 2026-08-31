"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, FileText, Search, Send } from "lucide-react";
import { useDebouncedValue } from "../../hooks/useDebouncedSearch";
import { useModalFocusTrap } from "../../hooks/useModalFocusTrap";
import { queryKeys, type Loan, type Remittance } from "../../hooks/useApi";

interface CommandItem {
  id: string;
  label: string;
  hint?: string;
  href: string;
  icon: "page" | "loan" | "remittance";
}

const NAV: { label: string; path: string }[] = [
  { label: "Dashboard", path: "" },
  { label: "Loans", path: "/loans" },
  { label: "Request a loan", path: "/request-loan" },
  { label: "Lend", path: "/lend" },
  { label: "Remittances", path: "/remittances" },
  { label: "Send remittance", path: "/send-remittance" },
  { label: "Activity", path: "/activity" },
  { label: "Analytics", path: "/analytics" },
  { label: "Wallet", path: "/wallet" },
  { label: "Settings", path: "/settings" },
];

function getLocale(pathname: string): string {
  const seg = pathname.split("/")[1];
  return ["en", "es", "tl"].includes(seg) ? seg : "en";
}

/**
 * Global search launched with Cmd/Ctrl+K.
 *
 * - Debounces input by 300ms.
 * - Filters navigation targets plus any loans / remittances already in the
 *   React Query cache — fully client-side, no network round-trip, no layout
 *   shift (the panel is a fixed overlay).
 */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const query = useDebouncedValue(input.trim().toLowerCase(), 300);

  const router = useRouter();
  const pathname = usePathname();
  const locale = getLocale(pathname);
  const queryClient = useQueryClient();

  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    setInput("");
    setActiveIndex(0);
  }, []);

  useModalFocusTrap({
    isOpen: open,
    onClose: close,
    containerRef: panelRef,
    initialFocusRef: inputRef,
  });

  // Global Cmd/Ctrl+K toggle.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const items = useMemo<CommandItem[]>(() => {
    const base = `/${locale}`;
    const navMatches: CommandItem[] = NAV.filter(
      (n) => !query || n.label.toLowerCase().includes(query),
    ).map((n) => ({
      id: `nav:${n.path}`,
      label: n.label,
      href: `${base}${n.path}`,
      icon: "page" as const,
    }));

    if (!query) return navMatches;

    const loans = queryClient.getQueryData<Loan[]>(queryKeys.loans.all()) ?? [];
    const loanMatches: CommandItem[] = loans
      .filter(
        (l) =>
          String(l.id).toLowerCase().includes(query) ||
          l.currency?.toLowerCase().includes(query) ||
          l.status?.toLowerCase().includes(query),
      )
      .slice(0, 5)
      .map((l) => ({
        id: `loan:${l.id}`,
        label: `Loan #${l.id}`,
        hint: `${l.amount} ${l.currency} · ${l.status}`,
        href: `${base}/loans/${l.id}`,
        icon: "loan" as const,
      }));

    const remittances = queryClient.getQueryData<Remittance[]>(queryKeys.remittances.all()) ?? [];
    const remittanceMatches: CommandItem[] = remittances
      .filter(
        (r) =>
          String(r.id).toLowerCase().includes(query) ||
          r.recipientAddress?.toLowerCase().includes(query) ||
          r.memo?.toLowerCase().includes(query) ||
          r.status?.toLowerCase().includes(query),
      )
      .slice(0, 5)
      .map((r) => ({
        id: `remittance:${r.id}`,
        label: `Remittance #${r.id}`,
        hint: `${r.amount} ${r.fromCurrency}→${r.toCurrency} · ${r.status}`,
        href: `${base}/remittances`,
        icon: "remittance" as const,
      }));

    return [...navMatches, ...loanMatches, ...remittanceMatches];
  }, [query, locale, queryClient]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  const go = useCallback(
    (item: CommandItem | undefined) => {
      if (!item) return;
      close();
      router.push(item.href);
    },
    [close, router],
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center bg-zinc-950/40 px-4 pt-[12vh] backdrop-blur-sm"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        className="w-full max-w-xl overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950"
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActiveIndex((i) => Math.min(i + 1, items.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActiveIndex((i) => Math.max(i - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            go(items[activeIndex]);
          }
        }}
      >
        <div className="flex items-center gap-2 border-b border-zinc-200 px-4 dark:border-zinc-800">
          <Search className="h-4 w-4 shrink-0 text-zinc-400" aria-hidden="true" />
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Search loans, remittances, pages…"
            aria-label="Search"
            className="w-full bg-transparent py-3.5 text-sm text-zinc-900 outline-none placeholder:text-zinc-400 dark:text-zinc-100"
          />
          <kbd className="hidden rounded border border-zinc-200 px-1.5 py-0.5 text-[10px] font-medium text-zinc-400 sm:block dark:border-zinc-700">
            Esc
          </kbd>
        </div>

        <ul className="max-h-[50vh] overflow-y-auto p-2" role="listbox" aria-label="Search results">
          {items.length === 0 ? (
            <li className="px-3 py-6 text-center text-sm text-zinc-400">No matches</li>
          ) : (
            items.map((item, index) => (
              <li key={item.id} role="option" aria-selected={index === activeIndex}>
                <button
                  type="button"
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => go(item)}
                  className={
                    "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition " +
                    (index === activeIndex
                      ? "bg-zinc-100 text-zinc-900 dark:bg-zinc-900 dark:text-zinc-50"
                      : "text-zinc-600 dark:text-zinc-300")
                  }
                >
                  <span className="text-zinc-400" aria-hidden="true">
                    {item.icon === "loan" ? (
                      <FileText className="h-4 w-4" />
                    ) : item.icon === "remittance" ? (
                      <Send className="h-4 w-4" />
                    ) : (
                      <ArrowRight className="h-4 w-4" />
                    )}
                  </span>
                  <span className="flex-1 truncate">{item.label}</span>
                  {item.hint ? (
                    <span className="truncate text-xs text-zinc-400">{item.hint}</span>
                  ) : null}
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
