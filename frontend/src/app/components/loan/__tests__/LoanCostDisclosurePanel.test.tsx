import { render, screen } from "@testing-library/react";
import { LoanCostDisclosureError, LoanCostDisclosurePanel } from "../LoanCostDisclosurePanel";
import {
  computeLoanCostDisclosure,
  reconcileWithAmortization,
  type LoanCostDisclosure,
} from "../../../utils/loanCostDisclosure";

function disclosure(overrides: Partial<Parameters<typeof computeLoanCostDisclosure>[0]> = {}) {
  const result = computeLoanCostDisclosure({
    principal: "1000",
    asset: "USDC",
    termDays: 30,
    annualRateBps: 1200,
    originationFeeBps: 100,
    lateFeeBps: 50,
    networkFee: { amount: "0.00001", asset: "XLM" },
    startDate: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.disclosure;
}

describe("LoanCostDisclosurePanel", () => {
  it("itemises the cost of credit", () => {
    render(<LoanCostDisclosurePanel disclosure={disclosure()} />);

    expect(screen.getByTestId("loan-cost-disclosure")).toBeInTheDocument();
    expect(screen.getByText("Amount requested")).toBeInTheDocument();
    expect(screen.getByText("Amount disbursed to you")).toBeInTheDocument();
    expect(screen.getByText("Interest over the term")).toBeInTheDocument();
    expect(screen.getByText("Origination fee")).toBeInTheDocument();
    expect(screen.getByText("Service fee")).toBeInTheDocument();
    expect(screen.getByText("Total cost of credit")).toBeInTheDocument();
    expect(screen.getAllByText("Total repayment")).not.toHaveLength(0);
  });

  it("shows both the nominal and the effective APR", () => {
    render(<LoanCostDisclosurePanel disclosure={disclosure()} />);
    const apr = screen.getByTestId("loan-cost-effective-apr");
    expect(apr).toHaveTextContent("12.00%");
    expect(apr).toHaveTextContent(/effective APR/);
  });

  it("renders a total equal to the sum of the components", () => {
    const d = disclosure();
    render(<LoanCostDisclosurePanel disclosure={d} />);
    const total = screen.getByTestId("loan-cost-disclosure-summary");
    const expected = Number(d.principal) + Number(d.totalCostOfCredit);
    expect(Number(d.totalRepayment)).toBeCloseTo(expected, 2);
    expect(total).toHaveTextContent("1,019.86");
  });

  it("always names the first due date", () => {
    render(<LoanCostDisclosurePanel disclosure={disclosure()} />);
    expect(screen.getByText("2026-01-31")).toBeInTheDocument();
  });

  it("discloses the network fee as separate from the loan total", () => {
    render(<LoanCostDisclosurePanel disclosure={disclosure()} />);
    expect(screen.getByText("Network fee (separate, not financed)")).toBeInTheDocument();
    expect(screen.getByText("0.00001 XLM")).toBeInTheDocument();
  });

  it("hides zero-fee rows and reports no late fee when none is configured", () => {
    render(
      <LoanCostDisclosurePanel disclosure={disclosure({ originationFeeBps: 0, lateFeeBps: 0 })} />,
    );
    expect(screen.queryByText("Origination fee")).not.toBeInTheDocument();
    expect(screen.getByText("None configured")).toBeInTheDocument();
  });

  it("discloses a configured late fee with its cap", () => {
    render(<LoanCostDisclosurePanel disclosure={disclosure()} />);
    expect(screen.getByText(/\/ day/)).toHaveTextContent("cap");
  });

  it("shows a rounding notice when the amount was rounded to asset precision", () => {
    render(<LoanCostDisclosurePanel disclosure={disclosure({ principal: "1000.005" })} />);
    expect(screen.getByTestId("loan-cost-rounding-notice")).toHaveTextContent("1,000.01");
  });

  it("marks the totals as an estimate when no authoritative schedule matched", () => {
    render(<LoanCostDisclosurePanel disclosure={disclosure()} />);
    expect(screen.getByTestId("loan-cost-source")).toHaveTextContent("Estimate");
  });

  it("marks the totals as authoritative when they match the backend schedule", () => {
    const d = disclosure({ originationFeeBps: 0 });
    const reconciliation = reconcileWithAmortization(d, {
      principal: 1000,
      totalInterest: 9.86,
      totalDue: 1009.86,
    });
    render(<LoanCostDisclosurePanel disclosure={d} reconciliation={reconciliation} />);

    expect(reconciliation.status).toBe("matched");
    expect(screen.getByTestId("loan-cost-source")).toHaveTextContent(
      "confirmed against the lending pool schedule",
    );
    expect(screen.queryByTestId("loan-cost-reconciliation-warning")).not.toBeInTheDocument();
  });

  it("warns when the authoritative schedule diverges from the local estimate", () => {
    const d = disclosure({ originationFeeBps: 0 });
    const reconciliation = reconcileWithAmortization(d, {
      principal: 1000,
      totalInterest: 5,
      totalDue: 1005,
    });
    render(<LoanCostDisclosurePanel disclosure={d} reconciliation={reconciliation} />);

    expect(screen.getByTestId("loan-cost-reconciliation-warning")).toHaveTextContent(
      /authoritative schedule differs/,
    );
  });

  it("explains a stale / unavailable schedule instead of hiding it", () => {
    const d: LoanCostDisclosure = disclosure();
    render(
      <LoanCostDisclosurePanel
        disclosure={d}
        reconciliation={reconcileWithAmortization(d, null)}
      />,
    );
    expect(screen.getByTestId("loan-cost-reconciliation-stale")).toHaveTextContent(
      /No authoritative schedule/,
    );
  });

  it("exposes the summary to assistive technology", () => {
    render(<LoanCostDisclosurePanel disclosure={disclosure()} />);
    const srOnly = screen.getByText(/Borrowing .* for 30 days/);
    expect(srOnly).toHaveTextContent("Total repayment");
  });

  it("renders each statement as a list item", () => {
    render(<LoanCostDisclosurePanel disclosure={disclosure()} />);
    const list = screen.getByTestId("loan-cost-disclosure-statements");
    expect(list.querySelectorAll("li").length).toBeGreaterThan(3);
  });
});

describe("LoanCostDisclosureError", () => {
  it("shows the typed failure and reassures that nothing was submitted", () => {
    render(
      <LoanCostDisclosureError
        error={{ code: "invalid_principal", message: "The loan amount must be greater than zero." }}
      />,
    );
    const alert = screen.getByTestId("loan-cost-disclosure-error");
    expect(alert).toHaveTextContent("Cost of loan unavailable");
    expect(alert).toHaveTextContent("The loan amount must be greater than zero.");
    expect(alert).toHaveTextContent("Nothing was submitted");
  });
});
