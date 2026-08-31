"use client";

/**
 * hooks/useUrlState.ts
 *
 * Type-safe synchronisation of UI state (filters, tabs, pagination, analytics
 * time ranges) with the URL query string.
 *
 * Why not `nuqs` / `next-usequerystate`?
 * The behaviour we need is small and well covered by the App Router primitives
 * (`useSearchParams` + `useRouter`), so we keep it dependency-free. The API
 * below is intentionally shaped like `nuqs` (parsers with defaults, a
 * `[value, setValue]` tuple) so a later migration is mechanical.
 *
 * Conventions (see docs/frontend/url-state.md):
 *  - A param equal to its default value is omitted from the URL.
 *  - Writes use `router.replace` with `scroll: false` so filtering does not add
 *    history noise; pass `{ history: "push" }` when a change should be a
 *    distinct back-button stop.
 *  - Browser back/forward works for free: `useSearchParams` re-renders on
 *    popstate, so state is derived, never mirrored into React state.
 */

import { useCallback, useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

export interface UrlStateParser<T> {
  /** Parse a raw string from the URL into a typed value. Return the default for anything invalid. */
  parse: (raw: string | null) => T;
  /** Serialise a typed value back to a string, or `null` to drop the param entirely. */
  serialize: (value: T) => string | null;
  /** Value considered "empty" — omitted from the URL and returned when the param is absent. */
  defaultValue: T;
}

export interface SetUrlStateOptions {
  /** "replace" (default) keeps history clean; "push" creates a back-button stop. */
  history?: "replace" | "push";
  /** Keep scroll position (default true — filtering should not jump the page). */
  scroll?: boolean;
}

/** String param with a default. */
export function stringParam(defaultValue = ""): UrlStateParser<string> {
  return {
    defaultValue,
    parse: (raw) => raw ?? defaultValue,
    serialize: (value) => (value === defaultValue || value === "" ? null : value),
  };
}

/** Integer param with a default (used for pagination). */
export function numberParam(defaultValue = 0): UrlStateParser<number> {
  return {
    defaultValue,
    parse: (raw) => {
      if (raw === null) return defaultValue;
      const parsed = Number.parseInt(raw, 10);
      return Number.isFinite(parsed) ? parsed : defaultValue;
    },
    serialize: (value) => (value === defaultValue ? null : String(value)),
  };
}

/** Boolean param (`?foo=1`). */
export function booleanParam(defaultValue = false): UrlStateParser<boolean> {
  return {
    defaultValue,
    parse: (raw) => (raw === null ? defaultValue : raw === "1" || raw === "true"),
    serialize: (value) => (value === defaultValue ? null : value ? "1" : "0"),
  };
}

/** Enum / literal-union param constrained to an allow-list. */
export function enumParam<const T extends string>(
  values: readonly T[],
  defaultValue: T,
): UrlStateParser<T> {
  return {
    defaultValue,
    parse: (raw) => (raw !== null && (values as readonly string[]).includes(raw) ? (raw as T) : defaultValue),
    serialize: (value) => (value === defaultValue ? null : value),
  };
}

/**
 * Bind a single query param to a typed `[value, setValue]` tuple.
 */
export function useUrlState<T>(
  key: string,
  parser: UrlStateParser<T>,
): [T, (next: T, options?: SetUrlStateOptions) => void] {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const value = useMemo(
    () => parser.parse(searchParams.get(key)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [searchParams, key],
  );

  const setValue = useCallback(
    (next: T, options?: SetUrlStateOptions) => {
      const params = new URLSearchParams(searchParams.toString());
      const serialized = parser.serialize(next);
      if (serialized === null) {
        params.delete(key);
      } else {
        params.set(key, serialized);
      }
      const query = params.toString();
      const href = query ? `${pathname}?${query}` : pathname;
      const scroll = options?.scroll ?? false;
      if (options?.history === "push") {
        router.push(href, { scroll });
      } else {
        router.replace(href, { scroll });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [router, pathname, searchParams, key],
  );

  return [value, setValue];
}

/**
 * Bind several params at once and update them atomically (a single navigation).
 * Useful when changing a filter must also reset pagination.
 *
 * @example
 * const [state, setState] = useUrlStates({
 *   status: enumParam(["all", "active", "repaid"] as const, "all"),
 *   page: numberParam(1),
 * });
 * setState({ status: "active", page: 1 });
 */
export function useUrlStates<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  S extends Record<string, UrlStateParser<any>>,
>(
  parsers: S,
): [
  { [K in keyof S]: S[K] extends UrlStateParser<infer T> ? T : never },
  (
    next: Partial<{ [K in keyof S]: S[K] extends UrlStateParser<infer T> ? T : never }>,
    options?: SetUrlStateOptions,
  ) => void,
] {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const values = useMemo(() => {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(parsers)) {
      result[key] = parsers[key].parse(searchParams.get(key));
    }
    return result as { [K in keyof S]: S[K] extends UrlStateParser<infer T> ? T : never };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const setValues = useCallback(
    (
      next: Partial<{ [K in keyof S]: S[K] extends UrlStateParser<infer T> ? T : never }>,
      options?: SetUrlStateOptions,
    ) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const key of Object.keys(next)) {
        const parser = parsers[key];
        const serialized = parser.serialize((next as Record<string, unknown>)[key]);
        if (serialized === null) {
          params.delete(key);
        } else {
          params.set(key, serialized);
        }
      }
      const query = params.toString();
      const href = query ? `${pathname}?${query}` : pathname;
      const scroll = options?.scroll ?? false;
      if (options?.history === "push") {
        router.push(href, { scroll });
      } else {
        router.replace(href, { scroll });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [router, pathname, searchParams],
  );

  return [values, setValues];
}
