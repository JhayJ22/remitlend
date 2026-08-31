"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query";

const DEFAULT_DELAY = 300;

/**
 * Debounce a rapidly-changing value.
 */
export function useDebouncedValue<T>(value: T, delay: number = DEFAULT_DELAY): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}

interface UseDebouncedSearchOptions<T> {
  /** Remote search function, called at most once per `delay` ms with a non-empty query. */
  queryFn: (query: string, signal?: AbortSignal) => Promise<T[]>;
  /** Namespace for the React Query cache key. */
  cacheKey: string;
  /** Already-loaded rows to filter locally for instant results. */
  localData?: T[];
  /** Predicate used to filter `localData` while the debounced request is pending. */
  localFilter?: (item: T, query: string) => boolean;
  delay?: number;
  minLength?: number;
  enabled?: boolean;
}

interface UseDebouncedSearchResult<T> {
  input: string;
  setInput: (value: string) => void;
  /** Debounced, trimmed query actually sent to the server. */
  query: string;
  /** Local matches available immediately (no network). */
  localResults: T[];
  /** Server results for the debounced query (cached per query string). */
  results: T[];
  isDebouncing: boolean;
  isFetching: boolean;
  clear: () => void;
}

/**
 * Client-side search primitive:
 *
 * - Debounces keystrokes (300ms by default) before hitting the network.
 * - Caches each distinct query in React Query so repeat searches are instant.
 * - Surfaces an instant local filter over already-loaded data so the list
 *   never goes blank while the debounced request is in flight.
 */
export function useDebouncedSearch<T>({
  queryFn,
  cacheKey,
  localData,
  localFilter,
  delay = DEFAULT_DELAY,
  minLength = 1,
  enabled = true,
}: UseDebouncedSearchOptions<T>): UseDebouncedSearchResult<T> {
  const [input, setInput] = useState("");
  const debounced = useDebouncedValue(input.trim(), delay);
  const queryClient = useQueryClient();
  const seededKeys = useRef<Set<string>>(new Set());

  const query = debounced.length >= minLength ? debounced : "";
  const isDebouncing = input.trim() !== debounced;

  const localResults = useMemo(() => {
    if (!localData || !localFilter || query.length < minLength) return [];
    return localData.filter((item) => localFilter(item, query.toLowerCase()));
  }, [localData, localFilter, query, minLength]);

  // Seed the query cache with local matches so the first paint is instant.
  useEffect(() => {
    if (query && localResults.length > 0 && !seededKeys.current.has(query)) {
      seededKeys.current.add(query);
      queryClient.setQueryData([cacheKey, "search", query], (existing: T[] | undefined) =>
        existing && existing.length > 0 ? existing : localResults,
      );
    }
  }, [query, localResults, cacheKey, queryClient]);

  const { data, isFetching } = useQuery<T[]>({
    queryKey: [cacheKey, "search", query],
    queryFn: ({ signal }) => queryFn(query, signal),
    enabled: enabled && query.length >= minLength,
    placeholderData: keepPreviousData,
    staleTime: 60 * 1000,
    gcTime: 5 * 60 * 1000,
  });

  return {
    input,
    setInput,
    query,
    localResults,
    results: data ?? localResults,
    isDebouncing,
    isFetching,
    clear: () => setInput(""),
  };
}
