import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OfferComparisonTable } from "./OfferComparisonTable";
import type { Loan } from "../../hooks/useApi";

const copy: Record<string, string> = {
  title: "Compare loan and pool offers",
  description: "Sort columns with the keyboard.",
  caption: "Loan and pool offer comparison.",
  summary:
    "Showing {visible} of {total} offers. Sorted by {column} {direction}. Filters: {filters}.",
  sortAction: "Activate to sort by this column",
  sortAscending: "ascending",
  sortDescending: "descending",
  loanName: "Loan {id}",
  poolName: "Lending pool",
  rate: "{value}%",
  termNone: "Flexible",
  "filters.searchLabel": "Search offers",
  "filters.searchPlaceholder": "Search by name or ID",
  "filters.currencyLabel": "Currency",
  "filters.kindLabel": "Offer type",
  "filters.statusLabel": "Status",
  "filters.all": "All",
  "filters.loan": "Loan",
  "filters.pool": "Pool",
  "columns.name": "Offer",
  "columns.kind": "Type",
  "columns.amount": "Amount available",
  "columns.ratePercent": "Rate / APY",
  "columns.termDays": "Term (days)",
  "columns.status": "Status",
  "states.loading": "Loading offers…",
  "states.error": "Offers could not be loaded.",
  "states.empty": "No offers match the current filters.",
  "states.invalid": "That action was invalid.",
};

jest.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: () => (key: string, values?: Record<string, unknown>) => {
    const template = (copy as Record<string, string>)[key] ?? key;
    if (!values) return template;
    return template.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? ""));
  },
}));

const loans: Loan[] = [
  {
    id: "1",
    amount: 500,
    currency: "USDC",
    interestRate: 9.5,
    termDays: 30,
    status: "active",
    borrowerId: "b1",
    createdAt: "2026-01-01",
  },
  {
    id: "2",
    amount: 800,
    currency: "USDT",
    interestRate: 12,
    termDays: 60,
    status: "active",
    borrowerId: "b2",
    createdAt: "2026-01-02",
  },
];

const poolStats = {
  totalDeposits: 12000,
  totalOutstanding: 1000,
  utilizationRate: 0.08,
  apy: 0.08,
  activeLoansCount: 2,
};

describe("OfferComparisonTable", () => {
  it("renders semantic column and row headers with a screen-reader caption and summary", () => {
    render(<OfferComparisonTable loans={loans} poolStats={poolStats} />);

    const table = screen.getByRole("table");
    expect(within(table).getByText("Loan and pool offer comparison.")).toBeInTheDocument();
    expect(within(table).getAllByRole("columnheader")).toHaveLength(6);
    expect(within(table).getAllByRole("rowheader")).toHaveLength(3);
    expect(screen.getByRole("status")).toHaveTextContent("Showing 3 of 3 offers");
    expect(screen.getAllByText("500.00 USDC")).toHaveLength(2);
    expect(screen.getAllByText("800.00 USDT")).toHaveLength(2);
    expect(screen.getAllByText("8.00%")).toHaveLength(2);
  });

  it("keeps focus on a sort header and discloses the new sort state", async () => {
    const user = userEvent.setup();
    render(<OfferComparisonTable loans={loans} poolStats={poolStats} />);

    const button = screen.getByRole("button", { name: /Amount available/ });
    button.focus();
    expect(button).toHaveFocus();

    await user.keyboard("{Enter}");

    expect(button).toHaveFocus();
    expect(button.closest("th")).toHaveAttribute("aria-sort", "ascending");
    expect(screen.getByRole("status")).toHaveTextContent("Sorted by Amount available ascending");

    await user.keyboard(" ");
    expect(button).toHaveFocus();
    expect(button.closest("th")).toHaveAttribute("aria-sort", "descending");
  });

  it("keeps focus in filters and discloses the resulting count and state", async () => {
    const user = userEvent.setup();
    render(<OfferComparisonTable loans={loans} poolStats={poolStats} />);

    const search = screen.getByLabelText("Search offers");
    await user.type(search, "Loan 2");

    expect(search).toHaveFocus();
    expect(search).toHaveValue("Loan 2");
    expect(screen.getAllByRole("status")[0]).toHaveTextContent("Showing 1 of 3 offers");
    expect(screen.getAllByRole("status")[0]).toHaveTextContent("Search offers: Loan 2");

    const kind = screen.getByLabelText("Offer type");
    await user.selectOptions(kind, "pool");
    expect(kind).toHaveFocus();
    expect(screen.getAllByRole("status")[0]).toHaveTextContent("Showing 0 of 3 offers");
    expect(screen.getByText("No offers match the current filters.")).toBeInTheDocument();
  });

  it("announces rejected invalid actions without mutating the view", () => {
    render(<OfferComparisonTable loans={loans} poolStats={poolStats} />);
    const search = screen.getByLabelText("Search offers");
    const summary = screen.getAllByRole("status")[0];
    const original = summary.textContent;

    fireEvent.change(search, { target: { value: "<script>alert(1)</script>" } });

    expect(search).toHaveValue("");
    expect(screen.getAllByRole("status")[0]).toHaveTextContent(original ?? "");
    expect(screen.getByText("That action was invalid.")).toBeInTheDocument();
  });

  it("renders responsive card definitions for every visible row", () => {
    const { container } = render(<OfferComparisonTable loans={loans} poolStats={poolStats} />);
    const cards = container.querySelectorAll("article");
    expect(cards).toHaveLength(3);
    cards.forEach((card) => {
      expect(card.querySelector("dl")).not.toBeNull();
      expect(card.querySelectorAll("dt")).toHaveLength(5);
    });
  });

  it("shows dedicated loading and failure states", () => {
    const { rerender } = render(<OfferComparisonTable loans={[]} isLoading />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading offers…");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();

    rerender(<OfferComparisonTable loans={[]} isError />);
    expect(screen.getByRole("alert")).toHaveTextContent("Offers could not be loaded.");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});
