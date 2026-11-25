export type OfferKind = "loan" | "pool";

export interface OfferRow {
  id: string;
  name: string;
  kind: OfferKind;
  currency: string;
  amount: number;
  ratePercent: number;
  termDays: number | null;
  status: string;
}

export type OfferSortKey = "name" | "kind" | "amount" | "ratePercent" | "termDays" | "status";
export type OfferSortDirection = "asc" | "desc";
export type OfferFilterKey = "query" | "currency" | "kind" | "status";

export interface OfferFilters {
  query: string;
  currency: string;
  kind: OfferKind | "all";
  status: string;
}

export interface OfferTableState {
  sortKey: OfferSortKey;
  direction: OfferSortDirection;
  filters: OfferFilters;
  revision: number;
  notice: "none" | "invalid";
}

export type OfferTableAction =
  | { type: "sort"; key: OfferSortKey }
  | { type: "filter"; key: OfferFilterKey; value: string }
  | { type: "reset" };

export const OFFER_SORT_KEYS: readonly OfferSortKey[] = [
  "name",
  "kind",
  "amount",
  "ratePercent",
  "termDays",
  "status",
];

export const OFFER_FILTER_KEYS: readonly OfferFilterKey[] = ["query", "currency", "kind", "status"];

const SAFE_FILTER_VALUE = /^[A-Za-z0-9 ._:-]*$/;
const MAX_FILTER_LENGTH = 80;

export const initialOfferTableState: OfferTableState = {
  sortKey: "name",
  direction: "asc",
  filters: { query: "", currency: "all", kind: "all", status: "all" },
  revision: 0,
  notice: "none",
};

function isOfferSortKey(value: unknown): value is OfferSortKey {
  return typeof value === "string" && (OFFER_SORT_KEYS as readonly string[]).includes(value);
}

function isOfferFilterKey(value: unknown): value is OfferFilterKey {
  return typeof value === "string" && (OFFER_FILTER_KEYS as readonly string[]).includes(value);
}

function isValidFilterValue(key: OfferFilterKey, value: unknown): value is string {
  if (typeof value !== "string" || value.length > MAX_FILTER_LENGTH) return false;
  if (!SAFE_FILTER_VALUE.test(value)) return false;
  if (key === "kind") return value === "all" || value === "loan" || value === "pool";
  return true;
}

export function applyOfferTableAction(
  state: OfferTableState,
  action: OfferTableAction,
): OfferTableState {
  if (!action || typeof action !== "object") return state;

  if (action.type === "sort") {
    if (!isOfferSortKey(action.key)) return { ...state, notice: "invalid" };
    const direction = state.sortKey === action.key && state.direction === "asc" ? "desc" : "asc";
    return {
      ...state,
      sortKey: action.key,
      direction,
      revision: state.revision + 1,
      notice: "none",
    };
  }

  if (action.type === "filter") {
    if (!isOfferFilterKey(action.key) || !isValidFilterValue(action.key, action.value)) {
      return { ...state, notice: "invalid" };
    }
    const value = action.value;
    if (state.filters[action.key] === value) return state;
    return {
      ...state,
      filters: { ...state.filters, [action.key]: value },
      revision: state.revision + 1,
      notice: "none",
    };
  }

  if (action.type === "reset") {
    return { ...initialOfferTableState, revision: state.revision + 1 };
  }

  return state;
}

function compareRows(left: OfferRow, right: OfferRow, key: OfferSortKey): number {
  if (key === "amount" || key === "ratePercent" || key === "termDays") {
    const a = key === "termDays" ? (left.termDays ?? Number.MAX_SAFE_INTEGER) : left[key];
    const b = key === "termDays" ? (right.termDays ?? Number.MAX_SAFE_INTEGER) : right[key];
    return a - b;
  }
  return left[key].localeCompare(right[key], undefined, { sensitivity: "base" });
}

export function selectOfferRows(rows: readonly OfferRow[], state: OfferTableState): OfferRow[] {
  const { query, currency, kind, status } = state.filters;
  const normalizedQuery = query.trim().toLowerCase();

  return rows
    .filter((row) => {
      if (currency !== "all" && row.currency !== currency) return false;
      if (kind !== "all" && row.kind !== kind) return false;
      if (status !== "all" && row.status !== status) return false;
      if (normalizedQuery && !`${row.name} ${row.id}`.toLowerCase().includes(normalizedQuery)) {
        return false;
      }
      return true;
    })
    .sort((left, right) => {
      if (state.sortKey === "termDays" && (left.termDays === null) !== (right.termDays === null)) {
        return left.termDays === null ? 1 : -1;
      }
      const primary = compareRows(left, right, state.sortKey);
      const ordered = state.direction === "asc" ? primary : -primary;
      return ordered === 0 ? left.id.localeCompare(right.id) : ordered;
    });
}

export function offerFilterOptions(rows: readonly OfferRow[]): OfferFilters {
  const currencies = new Set(rows.map((row) => row.currency));
  const statuses = new Set(rows.map((row) => row.status));
  return {
    query: "",
    currency: currencies.size === 1 ? [...currencies][0] : "all",
    kind: "all",
    status: statuses.size === 1 ? [...statuses][0] : "all",
  };
}
