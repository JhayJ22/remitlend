import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { TransactionRecoveryPanel } from "../TransactionRecoveryPanel";
import { planTransactionRecovery } from "../../../utils/transactionRecovery";

const HASH = "b".repeat(64);

function setup(error: unknown, context?: Parameters<typeof planTransactionRecovery>[1]) {
  const plan = planTransactionRecovery(error, context);
  const onAction = jest.fn();
  render(
    <TransactionRecoveryPanel plan={plan} txHash={context?.txHash ?? null} onAction={onAction} />,
  );
  return { plan, onAction };
}

describe("TransactionRecoveryPanel — rejected signature", () => {
  it("explains the rejection without blaming the user", () => {
    const { plan } = setup(new Error("User rejected the request"));
    expect(screen.getByTestId("transaction-recovery-headline")).toHaveTextContent(
      "You declined this request",
    );
    expect(plan.state).toBe("rejected");
  });

  it("offers re-signing as the primary action and no duplicate warning", () => {
    const { onAction } = setup(new Error("User rejected the request"));

    expect(screen.queryByTestId("transaction-recovery-duplicate-warning")).not.toBeInTheDocument();

    const retry = screen.getByTestId("transaction-recovery-action-retry_signing");
    fireEvent.click(retry);
    expect(onAction).toHaveBeenCalledWith("retry_signing");
  });

  it("always offers a support path with a support code", () => {
    const { onAction } = setup(new Error("User rejected the request"));
    expect(screen.getByTestId("transaction-recovery-support-code")).toHaveTextContent(
      /WALLET_REJECTED/,
    );
    fireEvent.click(screen.getByTestId("transaction-recovery-action-contact_support"));
    expect(onAction).toHaveBeenCalledWith("contact_support");
  });
});

describe("TransactionRecoveryPanel — expired request", () => {
  it("labels the state as expired and offers a fresh start", () => {
    setup(new Error("Transaction has expired"));
    expect(screen.getByTestId("transaction-recovery-panel")).toHaveAttribute(
      "data-state",
      "expired",
    );
    expect(screen.getByTestId("transaction-recovery-action-retry_signing")).toBeInTheDocument();
  });

  it("shows ordered recovery steps", () => {
    setup(new Error("Transaction has expired"));
    const steps = screen.getByTestId("transaction-recovery-steps");
    expect(steps.querySelectorAll("li").length).toBeGreaterThanOrEqual(2);
  });
});

describe("TransactionRecoveryPanel — already submitted", () => {
  it("warns against creating a duplicate loan", () => {
    setup(new Error("Network timeout while polling status"), { txHash: HASH, submitted: true });
    expect(screen.getByTestId("transaction-recovery-duplicate-warning")).toHaveTextContent(
      /duplicate loan/,
    );
  });

  it("never offers a sign-again action once a transaction exists", () => {
    setup(new Error("Network timeout while polling status"), { txHash: HASH, submitted: true });
    expect(
      screen.queryByTestId("transaction-recovery-action-retry_signing"),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("transaction-recovery-action-resubmit")).not.toBeInTheDocument();
  });

  it("leads with tracking, which requires no signature", () => {
    const { onAction } = setup(new Error("Network timeout while polling status"), {
      txHash: HASH,
      submitted: true,
    });
    fireEvent.click(screen.getByTestId("transaction-recovery-action-resume_tracking"));
    expect(onAction).toHaveBeenCalledWith("resume_tracking");
  });

  it("shows the transaction id and an explorer link", () => {
    setup(new Error("Network timeout"), { txHash: HASH, submitted: true });
    expect(screen.getByText(new RegExp(HASH.slice(0, 12)))).toBeInTheDocument();

    const explorer = screen.getByTestId("transaction-recovery-action-check_explorer");
    expect(explorer).toHaveAttribute("href", `https://stellar.expert/explorer/testnet/tx/${HASH}`);
    expect(explorer).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });

  it("hides the explorer and copy actions when there is no hash", () => {
    setup(new Error("Network timeout"), { submitted: true });
    expect(
      screen.queryByTestId("transaction-recovery-action-check_explorer"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("transaction-recovery-action-copy_tx_hash"),
    ).not.toBeInTheDocument();
  });
});

describe("TransactionRecoveryPanel — interaction", () => {
  it("copies the transaction id to the clipboard", async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    const { onAction } = setup(new Error("Network timeout"), { txHash: HASH, submitted: true });
    fireEvent.click(screen.getByTestId("transaction-recovery-action-copy_tx_hash"));

    await waitFor(() => expect(onAction).toHaveBeenCalledWith("copy_tx_hash"));
    expect(writeText).toHaveBeenCalledWith(HASH);
    expect(await screen.findByText("Copied")).toBeInTheDocument();
  });

  it("does not throw when clipboard access is denied", async () => {
    Object.assign(navigator, {
      clipboard: { writeText: jest.fn().mockRejectedValue(new Error("denied")) },
    });

    setup(new Error("Network timeout"), { txHash: HASH, submitted: true });
    expect(() =>
      fireEvent.click(screen.getByTestId("transaction-recovery-action-copy_tx_hash")),
    ).not.toThrow();
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
  });

  it("disables actions while the host is busy", () => {
    const plan = planTransactionRecovery(new Error("expired"));
    render(<TransactionRecoveryPanel plan={plan} busy />);
    expect(screen.getByTestId("transaction-recovery-action-retry_signing")).toBeDisabled();
  });

  it("renders without an action handler", () => {
    const plan = planTransactionRecovery(new Error("expired"));
    expect(() => {
      render(<TransactionRecoveryPanel plan={plan} />);
      fireEvent.click(screen.getByTestId("transaction-recovery-action-retry_signing"));
    }).not.toThrow();
  });
});
