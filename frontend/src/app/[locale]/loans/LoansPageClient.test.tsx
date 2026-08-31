import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LoansPageClient } from "./LoansPageClient";

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}));

const useBorrowerLoansPage = jest.fn();
jest.mock("../../hooks/useApi", () => ({
  useBorrowerLoansPage: (...args: unknown[]) => useBorrowerLoansPage(...args),
}));

jest.mock("../../stores/useWalletStore", () => ({
  useWalletStore: (selector: (state: { address: string | null }) => unknown) =>
    selector({ address: "GBORROWER" }),
  selectWalletAddress: (state: { address: string | null }) => state.address,
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

function loan(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    borrower: "GBORROWERADDRESS1",
    status: "active",
    totalOwed: 1000,
    nextPaymentDeadline: FUTURE,
    ...overrides,
  };
}

function mockLoansPage(state: Record<string, unknown>) {
  useBorrowerLoansPage.mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
    ...state,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("LoansPageClient", () => {
  it("renders the loading skeleton while the loans query is pending", () => {
    mockLoansPage({ isLoading: true });

    render(<LoansPageClient />);

    // The skeleton has no filter tabs / heading text.
    expect(screen.queryByRole("button", { name: "tabs.all" })).not.toBeInTheDocument();
    expect(screen.queryByText("title")).not.toBeInTheDocument();
  });

  it("renders an error panel when the loans query fails", () => {
    mockLoansPage({ isError: true });

    render(<LoansPageClient />);

    expect(screen.getByText(/Failed to load loans/i)).toBeInTheDocument();
  });

  it("renders a row per loan with status badge and formatted amount", () => {
    mockLoansPage({
      data: {
        items: [
          loan({ id: 1, borrower: "GBORROWER_ONE", totalOwed: 1000, status: "active" }),
          loan({ id: 2, borrower: "GBORROWER_TWO", totalOwed: 2500.5, status: "repaid" }),
        ],
        pageInfo: { hasNext: false, nextCursor: null },
      },
    });

    render(<LoansPageClient />);

    expect(screen.getByText("GBORROWER_ONE")).toBeInTheDocument();
    expect(screen.getByText("GBORROWER_TWO")).toBeInTheDocument();
    expect(screen.getByText("$1,000.00")).toBeInTheDocument();
    expect(screen.getByText("$2,500.50")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("Repaid")).toBeInTheDocument();
  });

  it("shows an overdue loan as defaulted when its next payment deadline has passed", () => {
    mockLoansPage({
      data: {
        items: [
          loan({
            id: 3,
            status: "active",
            nextPaymentDeadline: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
          }),
        ],
        pageInfo: { hasNext: false, nextCursor: null },
      },
    });

    render(<LoansPageClient />);

    expect(screen.getByText("Defaulted")).toBeInTheDocument();
  });

  it("renders the empty state when the borrower has no loans", () => {
    mockLoansPage({
      data: { items: [], pageInfo: { hasNext: false, nextCursor: null } },
    });

    render(<LoansPageClient />);

    expect(screen.getByText("empty.title")).toBeInTheDocument();
    expect(screen.queryByText("Previous")).not.toBeInTheDocument();
  });

  it("re-queries with the selected status filter when a tab is clicked", async () => {
    const user = userEvent.setup();
    mockLoansPage({
      data: { items: [loan()], pageInfo: { hasNext: false, nextCursor: null } },
    });

    render(<LoansPageClient />);
    expect(useBorrowerLoansPage).toHaveBeenLastCalledWith(
      "GBORROWER",
      expect.objectContaining({ status: undefined }),
    );

    await user.click(screen.getByRole("button", { name: "tabs.active" }));

    expect(useBorrowerLoansPage).toHaveBeenLastCalledWith(
      "GBORROWER",
      expect.objectContaining({ status: "active" }),
    );
  });

  it("advances the cursor when the next page is requested", async () => {
    const user = userEvent.setup();
    mockLoansPage({
      data: {
        items: [loan()],
        pageInfo: { hasNext: true, nextCursor: "cursor-2" },
      },
    });

    render(<LoansPageClient />);

    await user.click(screen.getByRole("button", { name: "Next" }));

    expect(useBorrowerLoansPage).toHaveBeenLastCalledWith(
      "GBORROWER",
      expect.objectContaining({ cursor: "cursor-2" }),
    );
  });
});
