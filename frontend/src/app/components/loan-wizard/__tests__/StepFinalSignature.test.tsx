import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import { StepFinalSignature } from "../StepFinalSignature";
import { pollTransactionStatus } from "../../../utils/transactionErrors";
import type { LoanWizardData } from "../LoanApplicationWizard";

const mutateAsync = jest.fn();
const show = jest.fn();

jest.mock("../../../utils/transactionErrors", () => ({
  ...jest.requireActual("../../../utils/transactionErrors"),
  // The transaction stays pending past the tracking window, so the flow lands
  // on the "already submitted" recovery path without touching the network.
  pollTransactionStatus: jest.fn(async () => ({
    status: "timeout",
    message: "Transaction is still pending. You can retry status tracking.",
    attempts: 1,
    dependencyFailure: false,
  })),
}));

jest.mock("../../../hooks/useApi", () => ({
  useCreateLoan: () => ({ mutateAsync, isPending: false }),
  useLoanAmortizationPreview: () => ({ data: undefined, isLoading: false, isError: false }),
}));

jest.mock("../../../hooks/useTransactionPreview", () => ({
  useTransactionPreview: () => ({
    isOpen: true,
    data: { operations: [], balanceChanges: [], network: "testnet" },
    isLoading: false,
    show,
    close: jest.fn(),
    confirm: jest.fn(),
  }),
}));

jest.mock("../../../hooks/useContractToast", () => ({
  useContractToast: () => ({
    showPending: () => "toast-1",
    showSuccess: jest.fn(),
    showError: jest.fn(),
    success: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock("../../../utils/soroban", () => ({
  buildUnsignedLoanRequestXdr: jest.fn(async () => "XDR"),
}));

const HASH = "c".repeat(64);

const data: LoanWizardData = {
  amount: "1000",
  asset: "USDC",
  termDays: 30,
  collateralConfirmed: true,
  creditScore: 720,
  maxAmount: 25_000,
};

function renderStep() {
  return render(
    <StepFinalSignature
      data={data}
      borrowerAddress="GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRS"
      onBack={jest.fn()}
      onSuccess={jest.fn()}
    />,
  );
}

describe("StepFinalSignature", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NEXT_PUBLIC_LENDING_POOL_CONTRACT_ID = "CONTRACT123";
  });

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_LENDING_POOL_CONTRACT_ID;
  });

  it("discloses the cost of loan before signing", async () => {
    renderStep();

    const panel = await screen.findByTestId("loan-cost-disclosure");
    expect(panel).toBeInTheDocument();
    expect(panel).toHaveTextContent("Total cost of credit");
    expect(panel).toHaveTextContent("Effective APR (all fees included)");
    expect(screen.getByTestId("loan-cost-effective-apr")).toHaveTextContent("12.00%");
  });

  it("includes the cost line items in the transaction preview", async () => {
    renderStep();
    await screen.findByTestId("loan-cost-disclosure");

    fireEvent.click(screen.getByRole("button", { name: /sign & submit/i }));

    expect(show).toHaveBeenCalledTimes(1);
    const [preview] = show.mock.calls[0];
    const details = preview.operations[0].details;
    expect(details).toHaveProperty("Effective APR (all fees)");
    expect(details).toHaveProperty("Interest Rate (nominal APR)");
    expect(details).toHaveProperty("Total Cost of Credit");
    expect(details).toHaveProperty("Total Repayment");
    expect(details).toHaveProperty("Amount Received");
  });

  it("disables signing when the cost of the loan cannot be computed", async () => {
    render(
      <StepFinalSignature
        data={{ ...data, amount: "not-a-number" }}
        borrowerAddress="GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRS"
        onBack={jest.fn()}
        onSuccess={jest.fn()}
      />,
    );

    expect(await screen.findByTestId("loan-cost-disclosure-error")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sign & submit/i })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /sign & submit/i }));
    expect(show).not.toHaveBeenCalled();
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("never resubmits a transaction that is already on chain", async () => {
    mutateAsync.mockResolvedValue({ id: "loan-1", txHash: HASH });

    renderStep();
    await screen.findByTestId("loan-cost-disclosure");
    fireEvent.click(screen.getByRole("button", { name: /sign & submit/i }));

    // Run the confirm callback the preview modal would invoke.
    const [, onConfirm] = show.mock.calls[0];
    await act(async () => {
      await onConfirm().catch(() => undefined);
    });

    await waitFor(() =>
      expect(screen.getByTestId("transaction-recovery-panel")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("transaction-recovery-duplicate-warning")).toBeInTheDocument();

    // No re-sign action may be offered.
    expect(
      screen.queryByTestId("transaction-recovery-action-retry_signing"),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("transaction-recovery-action-resubmit")).not.toBeInTheDocument();

    // Resuming tracking must re-read the same hash, not create a new loan.
    const callsBefore = mutateAsync.mock.calls.length;
    await act(async () => {
      fireEvent.click(screen.getByTestId("transaction-recovery-action-resume_tracking"));
    });
    expect(mutateAsync).toHaveBeenCalledTimes(callsBefore);
    expect(pollTransactionStatus).toHaveBeenCalledWith(HASH, expect.anything());
  }, 20_000);
});
