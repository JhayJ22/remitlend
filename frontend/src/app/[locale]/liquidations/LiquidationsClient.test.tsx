import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import LiquidationsClient from "./LiquidationsClient";
import {
  buildLiquidateLoanTransaction,
  submitLoanTransaction,
  useLiquidatableLoans,
  type LiquidatableLoan,
} from "../../hooks/useApi";
import { useWallet } from "../../components/providers/WalletProvider";
import { useContractToast } from "../../hooks/useContractToast";
import { useWalletStore } from "../../stores/useWalletStore";

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

jest.mock("../../hooks/useApi", () => ({
  queryKeys: { loans: { liquidatable: () => ["loans", "liquidatable"] } },
  useLiquidatableLoans: jest.fn(),
  buildLiquidateLoanTransaction: jest.fn(),
  submitLoanTransaction: jest.fn(),
}));

jest.mock("../../components/providers/WalletProvider", () => ({
  useWallet: jest.fn(),
}));

jest.mock("../../hooks/useContractToast", () => ({
  useContractToast: jest.fn(),
}));

const invalidateQueries = jest.fn();
jest.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries }),
}));

jest.mock("../../stores/useWalletStore", () => ({
  useWalletStore: jest.fn(),
  selectWalletAddress: (state: { address: string | null }) => state.address,
}));

const mockedUseLiquidatableLoans = useLiquidatableLoans as jest.Mock;
const mockedUseWallet = useWallet as jest.Mock;
const mockedUseContractToast = useContractToast as jest.Mock;
const mockedUseWalletStore = useWalletStore as unknown as jest.Mock;
const mockedBuild = buildLiquidateLoanTransaction as jest.Mock;
const mockedSubmit = submitLoanTransaction as jest.Mock;

const LOAN: LiquidatableLoan = {
  loanId: 12,
  borrower: "GBORROWER1234567890",
  collateral: 1500,
  totalDebt: 1800,
  healthFactor: 0.85,
  collateralRatio: 0.9,
  liquidationThreshold: 1,
  source: "contract",
};

const signTransaction = jest.fn();
const toast = {
  showPending: jest.fn(() => "toast-id"),
  showSuccess: jest.fn(),
  showError: jest.fn(),
  error: jest.fn(),
};

function setQuery(overrides: Partial<ReturnType<typeof useLiquidatableLoans>>) {
  mockedUseLiquidatableLoans.mockReturnValue({
    data: [],
    isLoading: false,
    isError: false,
    refetch: jest.fn(),
    ...overrides,
  } as unknown as ReturnType<typeof useLiquidatableLoans>);
}

beforeEach(() => {
  jest.clearAllMocks();
  signTransaction.mockResolvedValue("signed-xdr");
  mockedBuild.mockResolvedValue({ unsignedTxXdr: "unsigned-xdr" });
  mockedSubmit.mockResolvedValue({ txHash: "0xabc", status: "SUCCESS" });
  mockedUseWallet.mockReturnValue({ signTransaction });
  mockedUseContractToast.mockReturnValue(toast);
  mockedUseWalletStore.mockImplementation((selector: (s: { address: string | null }) => unknown) =>
    selector({ address: "GLIQUIDATOR000000000" }),
  );
  setQuery({ data: [LOAN] });
});

describe("LiquidationsClient rendering", () => {
  it("shows the skeleton while the liquidatable loans query is loading", () => {
    setQuery({ isLoading: true });
    render(<LiquidationsClient />);

    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByText("empty.title")).not.toBeInTheDocument();
  });

  it("renders the error empty-state when the query fails", () => {
    setQuery({ isError: true });
    render(<LiquidationsClient />);

    expect(screen.getByText("error.title")).toBeInTheDocument();
  });

  it("renders the empty-state when there are no liquidatable loans", () => {
    setQuery({ data: [] });
    render(<LiquidationsClient />);

    expect(screen.getByText("empty.title")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("renders a table row with the loan's financials", () => {
    render(<LiquidationsClient />);

    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByText("#12")).toBeInTheDocument();
    expect(screen.getByText("GBORROWER1234567890")).toBeInTheDocument();
    expect(screen.getByText("$1,500.00")).toBeInTheDocument();
    expect(screen.getByText("$1,800.00")).toBeInTheDocument();
    expect(screen.getByText("85.00%")).toBeInTheDocument();
  });

  it("refetches when the refresh control is clicked", async () => {
    const refetch = jest.fn();
    setQuery({ data: [LOAN], refetch });
    const user = userEvent.setup();
    render(<LiquidationsClient />);

    await user.click(screen.getByRole("button", { name: "refresh" }));
    expect(refetch).toHaveBeenCalled();
  });
});

describe("LiquidationsClient liquidation flow", () => {
  it("builds, signs and submits a liquidation transaction", async () => {
    const user = userEvent.setup();
    render(<LiquidationsClient />);

    await user.click(screen.getByRole("button", { name: "liquidate" }));

    await waitFor(() =>
      expect(mockedBuild).toHaveBeenCalledWith({
        loanId: 12,
        liquidatorPublicKey: "GLIQUIDATOR000000000",
      }),
    );
    expect(signTransaction).toHaveBeenCalledWith("unsigned-xdr");
    expect(mockedSubmit).toHaveBeenCalledWith("signed-xdr");
    await waitFor(() =>
      expect(toast.showSuccess).toHaveBeenCalledWith(
        "toast-id",
        expect.objectContaining({ txHash: "0xabc" }),
      ),
    );
    expect(invalidateQueries).toHaveBeenCalled();
  });

  it("shows an error toast and never builds a transaction without a connected wallet", async () => {
    mockedUseWalletStore.mockImplementation(
      (selector: (s: { address: string | null }) => unknown) => selector({ address: null }),
    );
    const user = userEvent.setup();
    render(<LiquidationsClient />);

    await user.click(screen.getByRole("button", { name: "liquidate" }));

    expect(toast.error).toHaveBeenCalled();
    expect(mockedBuild).not.toHaveBeenCalled();
  });

  it("reports a failed liquidation through the toast helper", async () => {
    mockedSubmit.mockRejectedValueOnce(new Error("submit failed"));
    const user = userEvent.setup();
    render(<LiquidationsClient />);

    await user.click(screen.getByRole("button", { name: "liquidate" }));

    await waitFor(() =>
      expect(toast.showError).toHaveBeenCalledWith(
        "toast-id",
        expect.objectContaining({ errorMessage: "submit failed" }),
      ),
    );
  });
});
