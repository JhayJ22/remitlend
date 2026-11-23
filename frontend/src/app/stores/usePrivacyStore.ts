import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";

/**
 * Reduced-data mode preference store (#838).
 *
 * When `reducedDataMode` is true, sensitive account identifiers (wallet
 * addresses) and balances are masked in the UI so they are absent from:
 *
 * - Copied text (copy buttons are disabled or copy the mask)
 * - Screenshots (text is rendered as a fixed-width mask, not the real value)
 * - Accessible names (aria-label/title are set to "hidden", not the real value)
 *
 * The preference is persisted to localStorage via Zustand's `persist`
 * middleware, mirroring the gamification store pattern. An inline script in
 * `layout.tsx` writes a `data-privacy` attribute on `<html>` before paint so
 * the first render already masks values (no flash of real data).
 *
 * The preference is client-side only. The authoritative source of truth
 * (database, blockchain) is never modified — only the display layer changes.
 */

export const PRIVACY_STORAGE_KEY = "remitlend-privacy";

interface PrivacyState {
  /** When true, sensitive values are masked in the UI. */
  reducedDataMode: boolean;
  /** True after the store has rehydrated from localStorage (SSR safety). */
  hydrated: boolean;
}

interface PrivacyActions {
  setReducedDataMode: (enabled: boolean) => void;
  toggleReducedDataMode: () => void;
  setHydrated: (hydrated: boolean) => void;
}

export type PrivacyStore = PrivacyState & PrivacyActions;

const initialState: PrivacyState = {
  reducedDataMode: false,
  hydrated: false,
};

export const usePrivacyStore = create<PrivacyStore>()(
  devtools(
    persist(
      (set, get) => ({
        ...initialState,

        setReducedDataMode: (enabled) => {
          set({ reducedDataMode: enabled }, false, "privacy/setReducedDataMode");
          // Reflect to the DOM data attribute so CSS can target masked values
          // and the inline script stays in sync across reloads.
          if (typeof document !== "undefined") {
            document.documentElement.dataset.privacy = enabled ? "reduced" : "full";
          }
        },

        toggleReducedDataMode: () => {
          get().setReducedDataMode(!get().reducedDataMode);
        },

        setHydrated: (hydrated) => {
          set({ hydrated }, false, "privacy/setHydrated");
        },
      }),
      {
        name: PRIVACY_STORAGE_KEY,
        // Only persist the preference, not the hydration flag.
        partialize: (state) => ({ reducedDataMode: state.reducedDataMode }),
        // After rehydration from localStorage, sync the DOM attribute.
        onRehydrateStorage: () => (state) => {
          if (state) {
            state.setHydrated(true);
            if (typeof document !== "undefined") {
              document.documentElement.dataset.privacy = state.reducedDataMode
                ? "reduced"
                : "full";
            }
          }
        },
      },
    ),
    { name: "PrivacyStore" },
  ),
);

// ── Selectors ──────────────────────────────────────────────────────────────────

export const selectReducedDataMode = (state: PrivacyStore): boolean =>
  state.reducedDataMode;

export const selectPrivacyHydrated = (state: PrivacyStore): boolean =>
  state.hydrated;

/**
 * Read the reduced-data-mode preference from localStorage without
 * initialising the store. Used by the inline anti-FOUC script in layout.tsx
 * so the DOM data attribute is set before the first React render.
 *
 * Returns false (full data) when localStorage is unavailable or the key is
 * absent, so the default is always to show real data (fail-open for display,
 * never silently hiding user data).
 */
export function readReducedDataModeFromStorage(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const raw = window.localStorage.getItem(PRIVACY_STORAGE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as { state?: { reducedDataMode?: boolean } };
    return parsed?.state?.reducedDataMode === true;
  } catch {
    return false;
  }
}
