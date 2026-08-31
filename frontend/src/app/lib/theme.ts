export type Theme = "light" | "dark" | "system";

export const THEME_STORAGE_KEY = "remitlend-theme";

export function getSystemTheme(): Theme {
  if (typeof window === "undefined") {
    return "light";
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function isTheme(value: string | null | undefined): value is Theme {
  return value === "dark" || value === "light" || value === "system";
}

function readThemeCookie(): Theme | null {
  if (typeof document === "undefined") {
    return null;
  }
  const match = document.cookie
    .split("; ")
    .find((row) => row.startsWith(`${THEME_STORAGE_KEY}=`));
  const value = match?.split("=")[1];
  return isTheme(value) ? value : null;
}

/**
 * Persist the preference to both localStorage (fast client reads) and a cookie
 * (survives storage clears and is readable by the server for SSR).
 */
export function persistTheme(theme: Theme) {
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      /* storage unavailable */
    }
  }
  if (typeof document !== "undefined") {
    // 1 year, site-wide, lax so it rides top-level navigations.
    document.cookie = `${THEME_STORAGE_KEY}=${theme}; path=/; max-age=31536000; samesite=lax`;
  }
}

export function getStoredTheme(): Theme | null {
  if (typeof window === "undefined") {
    return null;
  }
  const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
  return isTheme(storedTheme) ? storedTheme : readThemeCookie();
}

export function applyTheme(theme: Theme) {
  if (typeof document === "undefined") {
    return;
  }
  const root = document.documentElement;
  if (theme === "system") {
    const resolved = getSystemTheme();
    root.dataset.theme = "system";
    root.classList.toggle("dark", resolved === "dark");
  } else {
    root.dataset.theme = theme;
    root.classList.toggle("dark", theme === "dark");
  }
}

export function resolveInitialTheme(): Theme {
  if (typeof document !== "undefined") {
    const presetTheme = document.documentElement.dataset.theme;
    if (presetTheme === "dark" || presetTheme === "light" || presetTheme === "system") {
      return presetTheme as Theme;
    }
  }
  return getStoredTheme() ?? getSystemTheme();
}
