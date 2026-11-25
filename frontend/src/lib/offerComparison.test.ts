import {
  applyOfferTableAction,
  initialOfferTableState,
  selectOfferRows,
  type OfferRow,
  type OfferSortKey,
} from "./offerComparison";
import { buildLoanOfferRows, buildOfferRows, buildPoolOfferRows } from "./offerRows";

const rows: OfferRow[] = [
  {
    id: "loan-2",
    name: "Loan 2",
    kind: "loan",
    currency: "USDC",
    amount: 500,
    ratePercent: 12,
    termDays: 30,
    status: "active",
  },
  {
    id: "pool-primary",
    name: "Lending pool",
    kind: "pool",
    currency: "USDC",
    amount: 12000,
    ratePercent: 8,
    termDays: null,
    status: "open",
  },
  {
    id: "loan-1",
    name: "Loan 1",
    kind: "loan",
    currency: "USDT",
    amount: 500,
    ratePercent: 9.5,
    termDays: 90,
    status: "active",
  },
];

describe("offer comparison state", () => {
  it("sorts ascending then descending and increments the revision", () => {
    const first = applyOfferTableAction(initialOfferTableState, {
      type: "sort",
      key: "amount",
    });
    expect(first.sortKey).toBe("amount");
    expect(first.direction).toBe("asc");
    expect(first.revision).toBe(1);

    const second = applyOfferTableAction(first, { type: "sort", key: "amount" });
    expect(second.direction).toBe("desc");
    expect(second.revision).toBe(2);
  });

  it("rejects invalid or stale sort actions without changing data", () => {
    const rejected = applyOfferTableAction(initialOfferTableState, {
      type: "sort",
      key: "drop-table" as OfferSortKey,
    });
    expect(rejected.revision).toBe(initialOfferTableState.revision);
    expect(rejected.notice).toBe("invalid");
    expect(rejected.sortKey).toBe(initialOfferTableState.sortKey);

    const unchangedFilter = applyOfferTableAction(initialOfferTableState, {
      type: "filter",
      key: "currency",
      value: "all",
    });
    expect(unchangedFilter).toBe(initialOfferTableState);
  });

  it("validates filters and rejects unsafe values", () => {
    const filtered = applyOfferTableAction(initialOfferTableState, {
      type: "filter",
      key: "query",
      value: "  Loan 1  ",
    });
    expect(filtered.filters.query).toBe("  Loan 1  ");
    expect(selectOfferRows(rows, filtered).map((row) => row.id)).toEqual(["loan-1"]);
    expect(filtered.revision).toBe(1);

    for (const value of ["<script>", "../etc/passwd", "x".repeat(81), "loan\x00"]) {
      const rejected = applyOfferTableAction(filtered, {
        type: "filter",
        key: "query",
        value,
      });
      expect(rejected.filters.query).toBe("  Loan 1  ");
      expect(rejected.notice).toBe("invalid");
    }

    const rejectedKind = applyOfferTableAction(initialOfferTableState, {
      type: "filter",
      key: "kind",
      value: "admin",
    });
    expect(rejectedKind.filters.kind).toBe("all");
    expect(rejectedKind.notice).toBe("invalid");
  });

  it("resets to the initial view while preserving an auditable revision", () => {
    const filtered = applyOfferTableAction(initialOfferTableState, {
      type: "filter",
      key: "kind",
      value: "pool",
    });
    const reset = applyOfferTableAction(filtered, { type: "reset" });
    expect(reset.filters).toEqual(initialOfferTableState.filters);
    expect(reset.sortKey).toBe("name");
    expect(reset.revision).toBe(filtered.revision + 1);
  });
});

describe("selectOfferRows", () => {
  it("filters by kind, currency, status, and query", () => {
    const state = {
      ...initialOfferTableState,
      filters: { query: "loan", currency: "USDC", kind: "loan" as const, status: "active" },
    };
    expect(selectOfferRows(rows, state).map((row) => row.id)).toEqual(["loan-2"]);
  });

  it("sorts money and rate numerically and keeps stable ties", () => {
    const byAmount = selectOfferRows(rows, {
      ...initialOfferTableState,
      sortKey: "amount",
      direction: "asc",
    });
    expect(byAmount.map((row) => row.id)).toEqual(["loan-1", "loan-2", "pool-primary"]);

    const byRateDesc = selectOfferRows(rows, {
      ...initialOfferTableState,
      sortKey: "ratePercent",
      direction: "desc",
    });
    expect(byRateDesc.map((row) => row.id)).toEqual(["loan-2", "loan-1", "pool-primary"]);
  });

  it("keeps rows with no term at the end regardless of direction", () => {
    const byTerm = selectOfferRows(rows, {
      ...initialOfferTableState,
      sortKey: "termDays",
      direction: "desc",
    });
    expect(byTerm[byTerm.length - 1].id).toBe("pool-primary");
  });
});

describe("offer row adapters", () => {
  it("preserves loan source currency and exact amount units", () => {
    const [row] = buildLoanOfferRows(
      [
        {
          id: "7",
          amount: 1234.56,
          currency: "USDC",
          interestRate: 8.25,
          termDays: 60,
          status: "active",
          borrowerId: "b",
          createdAt: "2026-01-01",
        },
      ],
      (id) => `Préstamo ${id}`,
    );
    expect(row).toMatchObject({
      id: "loan-7",
      name: "Préstamo 7",
      currency: "USDC",
      amount: 1234.56,
      ratePercent: 8.25,
      termDays: 60,
      status: "active",
    });
  });

  it("converts pool APY to a displayed percentage without changing deposit units", () => {
    const [row] = buildPoolOfferRows(
      {
        totalDeposits: 9876.54,
        totalOutstanding: 1000,
        utilizationRate: 0.1,
        apy: 0.0825,
        activeLoansCount: 1,
      },
      "Pool",
    );
    expect(row.amount).toBe(9876.54);
    expect(row.ratePercent).toBe(8.25);
    expect(row.termDays).toBeNull();
  });

  it("returns no pool rows when pool stats are unavailable", () => {
    expect(buildPoolOfferRows(undefined, "Pool")).toEqual([]);
    expect(buildOfferRows([], undefined, (id) => id, "Pool")).toEqual([]);
  });
});
