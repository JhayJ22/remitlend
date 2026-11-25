"use client";

/**
 * ThemeSwitcher — issue #808
 *
 * Renders a three-way toggle: dark → light → system.
 * - "system" reads the prefers-color-scheme media query and updates
 *   dynamically when it changes (handled in useThemeStore).
 * - The chosen theme is persisted to localStorage (and a cookie) via
 *   useThemeStore / lib/theme.ts.
 * - The <html> element's class is updated to "dark" or "light" so Tailwind's
 *   dark-mode variant works correctly.
 */

import { useEffect } from "react";
import { Sun, Moon, Monitor } from "lucide-react";
import { useThemeStore } from "../../stores/useThemeStore";
import type { Theme } from "../../lib/theme";

const MODES: { value: Theme; label: string; Icon: React.ElementType }[] = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "system", label: "System", Icon: Monitor },
];

interface ThemeSwitcherProps {
  /** Additional CSS classes for the wrapper element. */
  className?: string;
}

export function ThemeSwitcher({ className }: ThemeSwitcherProps) {
  const theme = useThemeStore((s) => s.theme);
  const hydrated = useThemeStore((s) => s.hydrated);
  const setTheme = useThemeStore((s) => s.setTheme);
  const initializeTheme = useThemeStore((s) => s.initializeTheme);

  useEffect(() => {
    if (!hydrated) {
      initializeTheme();
    }
  }, [hydrated, initializeTheme]);

  // Prevent hydration mismatch: render an invisible placeholder until the
  // stored preference has been read from localStorage.
  if (!hydrated) {
    return (
      <div
        className="flex items-center gap-1 p-1 rounded-lg bg-zinc-100 dark:bg-zinc-800"
        aria-hidden="true"
      >
        {MODES.map((m) => (
          <div key={m.value} className="h-8 w-8 rounded-md" />
        ))}
      </div>
    );
  }

  return (
    <div
      role="group"
      aria-label="Color theme"
      className={[
        "flex items-center gap-1 p-1 rounded-lg",
        "bg-zinc-100 dark:bg-zinc-800",
        className ?? "",
      ]
        .join(" ")
        .trim()}
    >
      {MODES.map(({ value, label, Icon }) => {
        const isActive = theme === value;
        return (
          <button
            key={value}
            onClick={() => setTheme(value)}
            aria-pressed={isActive}
            aria-label={`${label} mode${isActive ? " (active)" : ""}`}
            title={`${label} mode`}
            className={[
              "flex items-center justify-center h-8 w-8 rounded-md transition-colors",
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2",
              "focus-visible:outline-indigo-500",
              isActive
                ? "bg-white dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 shadow-sm"
                : "text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200",
            ]
              .join(" ")
              .trim()}
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
            <span className="sr-only">{label} mode</span>
          </button>
        );
      })}
    </div>
  );
}
