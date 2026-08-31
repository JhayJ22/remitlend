import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LoanApplicationWizard } from "../LoanApplicationWizard";

// Each real step is a large form with its own dependencies (money policy,
// signature flow, NFT lookups). The wizard's own responsibility is the step
// state machine — navigation, clamping, error reset and submission wiring — so
// the steps are stubbed with buttons that invoke the callbacks the wizard hands
// them.

jest.mock("../WizardStepper", () => ({
  WizardStepper: ({ currentStep }: { currentStep: number }) => (
    <div data-testid="stepper">step-{currentStep}</div>
  ),
}));

jest.mock("../StepAmountAsset", () => ({
  StepAmountAsset: ({
    onNext,
    onError,
    onChange,
    error,
  }: {
    onNext: () => void;
    onError: (m: string | null) => void;
    onChange: (u: Record<string, unknown>) => void;
    error: string | null;
  }) => (
    <div>
      <p>panel: amount</p>
      {error ? <p role="alert">{error}</p> : null}
      <button onClick={() => onChange({ amount: "500" })}>amount-set</button>
      <button onClick={() => onError("Enter a valid loan amount.")}>amount-error</button>
      <button onClick={onNext}>amount-next</button>
    </div>
  ),
}));

jest.mock("../StepRepaymentSchedule", () => ({
  StepRepaymentSchedule: ({ onNext, onBack }: { onNext: () => void; onBack: () => void }) => (
    <div>
      <p>panel: repayment</p>
      <button onClick={onBack}>repayment-back</button>
      <button onClick={onNext}>repayment-next</button>
    </div>
  ),
}));

jest.mock("../StepCollateralNFT", () => ({
  StepCollateralNFT: ({ onNext, onBack }: { onNext: () => void; onBack: () => void }) => (
    <div>
      <p>panel: collateral</p>
      <button onClick={onBack}>collateral-back</button>
      <button onClick={onNext}>collateral-next</button>
    </div>
  ),
}));

jest.mock("../StepFinalSignature", () => ({
  StepFinalSignature: ({
    onBack,
    onSuccess,
    borrowerAddress,
  }: {
    onBack: () => void;
    onSuccess: (loanId: string) => void;
    borrowerAddress: string;
  }) => (
    <div>
      <p>panel: signature</p>
      <p>signer: {borrowerAddress}</p>
      <button onClick={onBack}>signature-back</button>
      <button onClick={() => onSuccess("loan-123")}>signature-submit</button>
    </div>
  ),
}));

function renderWizard(props: Partial<React.ComponentProps<typeof LoanApplicationWizard>> = {}) {
  const onSuccess = jest.fn();
  render(
    <LoanApplicationWizard
      borrowerAddress="GBORROWERADDRESS"
      creditScore={720}
      maxAmount={5000}
      onSuccess={onSuccess}
      {...props}
    />,
  );
  return { onSuccess };
}

describe("LoanApplicationWizard", () => {
  it("starts on step 1 (amount & asset)", () => {
    renderWizard();

    expect(screen.getByText("panel: amount")).toBeInTheDocument();
    expect(screen.getByTestId("stepper")).toHaveTextContent("step-1");
  });

  it("walks forward through every step in order", async () => {
    const user = userEvent.setup();
    renderWizard();

    await user.click(screen.getByRole("button", { name: "amount-next" }));
    expect(screen.getByText("panel: repayment")).toBeInTheDocument();
    expect(screen.getByTestId("stepper")).toHaveTextContent("step-2");

    await user.click(screen.getByRole("button", { name: "repayment-next" }));
    expect(screen.getByText("panel: collateral")).toBeInTheDocument();
    expect(screen.getByTestId("stepper")).toHaveTextContent("step-3");

    await user.click(screen.getByRole("button", { name: "collateral-next" }));
    expect(screen.getByText("panel: signature")).toBeInTheDocument();
    expect(screen.getByTestId("stepper")).toHaveTextContent("step-4");
  });

  it("walks back to a previous step", async () => {
    const user = userEvent.setup();
    renderWizard();

    await user.click(screen.getByRole("button", { name: "amount-next" }));
    await user.click(screen.getByRole("button", { name: "repayment-next" }));
    expect(screen.getByText("panel: collateral")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "collateral-back" }));
    expect(screen.getByText("panel: repayment")).toBeInTheDocument();
    expect(screen.getByTestId("stepper")).toHaveTextContent("step-2");
  });

  it("does not go back past the first step", async () => {
    const user = userEvent.setup();
    renderWizard();

    // Step 1 has no back control; the stepper stays on step 1.
    expect(screen.getByTestId("stepper")).toHaveTextContent("step-1");
    await user.click(screen.getByRole("button", { name: "amount-set" }));
    expect(screen.getByTestId("stepper")).toHaveTextContent("step-1");
  });

  it("does not advance past the final step", async () => {
    const user = userEvent.setup();
    renderWizard();

    await user.click(screen.getByRole("button", { name: "amount-next" }));
    await user.click(screen.getByRole("button", { name: "repayment-next" }));
    await user.click(screen.getByRole("button", { name: "collateral-next" }));
    expect(screen.getByTestId("stepper")).toHaveTextContent("step-4");

    // The final step exposes no "next"; submitting is the only forward action.
    expect(screen.queryByRole("button", { name: /-next$/ })).not.toBeInTheDocument();
  });

  it("surfaces a step validation error and clears it on navigation", async () => {
    const user = userEvent.setup();
    renderWizard();

    await user.click(screen.getByRole("button", { name: "amount-error" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a valid loan amount.");

    await user.click(screen.getByRole("button", { name: "amount-next" }));
    expect(screen.getByText("panel: repayment")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "repayment-back" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("passes the borrower address to the signature step and reports the new loan id", async () => {
    const user = userEvent.setup();
    const { onSuccess } = renderWizard({ borrowerAddress: "GSIGNER99" });

    await user.click(screen.getByRole("button", { name: "amount-next" }));
    await user.click(screen.getByRole("button", { name: "repayment-next" }));
    await user.click(screen.getByRole("button", { name: "collateral-next" }));

    expect(screen.getByText("signer: GSIGNER99")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "signature-submit" }));
    expect(onSuccess).toHaveBeenCalledWith("loan-123");
  });
});
