import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LendPageClient } from "./LendPageClient";
import {
  useDepositorPortfolio,
  useInvalidatePoolStats,
  useLoans,
  usePoolStats,
  useYieldHistory,
} from "../../hooks/useApi";
import { useDepositOperation, useWithdrawalOperation } from "../../hooks/useRepaymentOperation";
import { useWalletStore } from "../../stores/useWalletStore";

jest.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}));

jest.mock("../../hooks/useApi", () => ({
  useDepositorPortfolio: jest.fn(),
  useInvalidatePoolStats: jest.fn(),
  useLoans: jest.fn(),
  usePoolStats: jest.fn(),
  useYieldHistory: jest.fn(),
}));

jest.mock("../../hooks/useRepaymentOperation", () => ({
  useDepositOperation: jest.fn(),
  useWithdrawalOperation: jest.fn(),
}));

jest.mock("../../hooks/useSSE", () => ({
  useSSE: () => "connected",
}));

jest.mock("../../stores/useWalletStore", () => ({
  useWalletStore: jest.fn(),
  selectWalletAddress: (state: { address: string | null }) => state.address,
}));

jest.mock("../../components/charts/YieldEarningsChart", () => ({
  YieldEarningsChart: ({ data }: { data: unknown[] }) => (
    <div data-testid="yield-chart">points:{data.length}</div>
  ),
}));

jest.mock("../../components/ui/OperationProgress", () => ({
  OperationProgress: () => null,
}));

const mockedPoolStats = usePoolStats as jest.Mock;
const mockedDepositor = useDepositorPortfolio as jest.Mock;
const mockedLoans = useLoans as jest.Mock;
const mockedYield = useYieldHistory as jest.Mock;
const mockedInvalidate = useInvalidatePoolStats as jest.Mock;
const mockedDepositOp = useDepositOperation as jest.Mock;
const mockedWithdrawalOp = useWithdrawalOperation as jest.Mock;
const mockedUseWalletStore = useWalletStore as unknown as jest.Mock;

const ADDRESS = "GDEPOSITOR0000000000";
const executeDeposit = jest.fn();
const executeWithdrawal = jest.fn();

function connectWallet(address: string | null) {
  mockedUseWalletStore.mockImplementation((selector: (s: { address: string | null }) => unknown) =>
    selector({ address }),
  );
}

function setQueries(
  overrides: {
    pool?: Record<string, unknown>;
    depositor?: Record<string, unknown>;
    loans?: Record<string, unknown>;
    yieldHistory?: Record<string, unknown>;
  } = {},
) {
  mockedPoolStats.mockReturnValue({
    data: {
      totalDeposits: 12000,
      utilizationRate: 0.5,
      apy: 0.08,
      activeLoansCount: 3,
      withdrawalCooldownLedgers: 0,
    },
    isLoading: false,
    isError: false,
    ...overrides.pool,
  });
  mockedDepositor.mockReturnValue({
    data: { depositAmount: 5000, sharePercent: 0.25, estimatedYield: 320, lastDepositAt: null },
    isLoading: false,
    isError: false,
    ...overrides.depositor,
  });
  mockedLoans.mockReturnValue({
    data: [],
    isLoading: false,
    isError: false,
    ...overrides.loans,
  });
  mockedYield.mockReturnValue({
    data: [{ date: "2026-01-01", earnings: 100, apy: 0.08, principal: 5000 }],
    isLoading: false,
    isError: false,
    ...overrides.yieldHistory,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  connectWallet(ADDRESS);
  mockedInvalidate.mockReturnValue(jest.fn());
  mockedDepositOp.mockReturnValue({ executeDeposit, isLoading: false, transaction: null });
  mockedWithdrawalOp.mockReturnValue({ executeWithdrawal, isLoading: false, transaction: null });
  setQueries();
});

describe("LendPageClient", () => {
  it("prompts the visitor to connect a wallet when none is connected", () => {
    connectWallet(null);
    render(<LendPageClient />);

    expect(
      screen.getByText("Connect your wallet to view your lending pool portfolio."),
    ).toBeInTheDocument();
  });

  it("renders the pool statistics for a connected lender", () => {
    render(<LendPageClient />);

    expect(screen.getByText("$12,000.00")).toBeInTheDocument();
    expect(screen.getByText("50.00%")).toBeInTheDocument();
    expect(screen.getByText("8.00%")).toBeInTheDocument();

    const activeLoansCard = screen.getByText("Active Loans").closest("article");
    expect(activeLoansCard).not.toBeNull();
    expect(within(activeLoansCard as HTMLElement).getByText("3")).toBeInTheDocument();
  });

  it("renders the depositor's position summary", () => {
    render(<LendPageClient />);

    expect(screen.getByText("$5,000.00")).toBeInTheDocument();
    expect(screen.getByText("25.00%")).toBeInTheDocument();
    expect(screen.getByText("$320.00")).toBeInTheDocument();
  });

  it("submits a deposit with the parsed amount and connected address", async () => {
    const user = userEvent.setup();
    render(<LendPageClient />);

    await user.click(screen.getByRole("button", { name: "Deposit" }));

    expect(executeDeposit).toHaveBeenCalledWith({ amount: 100, depositorAddress: ADDRESS });
  });

  it("submits a withdrawal with the parsed amount and connected address", async () => {
    const user = userEvent.setup();
    render(<LendPageClient />);

    await user.click(screen.getByRole("button", { name: "Withdraw" }));

    expect(executeWithdrawal).toHaveBeenCalledWith({ amount: 50, depositorAddress: ADDRESS });
  });

  it("does not submit a deposit for a non-positive amount", async () => {
    const user = userEvent.setup();
    render(<LendPageClient />);

    const input = screen.getByLabelText("Deposit Amount");
    await user.clear(input);
    await user.type(input, "0");
    await user.click(screen.getByRole("button", { name: "Deposit" }));

    expect(executeDeposit).not.toHaveBeenCalled();
  });

  it("passes mapped yield history to the earnings chart", () => {
    render(<LendPageClient />);

    expect(screen.getByTestId("yield-chart")).toHaveTextContent("points:1");
  });

  it("shows the empty state when there is no yield history", () => {
    setQueries({ yieldHistory: { data: [] } });
    render(<LendPageClient />);

    expect(screen.queryByTestId("yield-chart")).not.toBeInTheDocument();
    expect(screen.getByText("No yield history yet")).toBeInTheDocument();
  });

  it("renders a dashboard-level error when a query fails", () => {
    setQueries({ pool: { data: undefined, isError: true } });
    render(<LendPageClient />);

    expect(
      screen.getByText("Failed to load lender dashboard data. Please try again."),
    ).toBeInTheDocument();
  });

  it("shows a loading skeleton state while pool data is loading", () => {
    setQueries({ pool: { data: undefined, isLoading: true } });
    render(<LendPageClient />);

    // Stat values are replaced by skeletons while loading.
    expect(screen.queryByText("$12,000.00")).not.toBeInTheDocument();
    expect(screen.getByText("Total Pool Size")).toBeInTheDocument();
  });
});
