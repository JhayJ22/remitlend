import { render, screen, within, fireEvent } from "@testing-library/react";
import { RepaymentScheduleTable } from "../RepaymentScheduleTable";
import type { LoanAmortization } from "../../../hooks/useApi";

const amortization: LoanAmortization = {
  principal: 600,
  interestRateBps: 1200,
  termLedgers: 17280 * 60,
  totalInterest: 72,
  totalDue: 684,
  schedule: [
    { date: "2026-01-01T00:00:00Z", principalPortion: 300, interestPortion: 36, feePortion: 6, totalDue: 342, runningBalance: 300 },
    { date: "2026-02-01T00:00:00Z", principalPortion: 300, interestPortion: 36, feePortion: 6, totalDue: 342, runningBalance: 0 },
  ],
};

describe("RepaymentScheduleTable", () => {
  it("renders the six columns with an accessible caption and sort state", () => {
    render(<RepaymentScheduleTable amortization={amortization} showSummaryCards={false} />);
    expect(screen.getByRole("table")).toHaveAccessibleName(/repayment schedule/i);
    const headers = screen.getAllByRole("columnheader");
    expect(headers.map((h) => h.textContent)).toEqual([
      "Payment Date",
      "Total Amount",
      "Interest",
      "Principal",
      "Fees",
      "Remaining Balance",
    ]);
    headers.forEach((h) => expect(h).toHaveAttribute("scope", "col"));
    expect(headers[0]).toHaveAttribute("aria-sort", "none");

    const firstRow = screen.getAllByRole("row")[1]!;
    const cells = within(firstRow).getAllByRole("cell").map((c) => c.textContent);
    expect(cells).toEqual(["$342.00", "$36.00", "$300.00", "$6.00", "$300.00"]);
  });

  it("totals row matches the column sums", () => {
    render(<RepaymentScheduleTable amortization={amortization} showSummaryCards={false} />);
    const totals = within(screen.getByTestId("repayment-schedule-totals"));
    expect(totals.getAllByRole("cell").map((c) => c.textContent)).toEqual([
      "$684.00",
      "$72.00",
      "$600.00",
      "$12.00",
      "",
    ]);
  });

  it("sorts by a column and updates aria-sort", () => {
    render(<RepaymentScheduleTable amortization={amortization} showSummaryCards={false} />);
    fireEvent.click(screen.getByRole("button", { name: /remaining balance/i }));
    expect(screen.getByRole("columnheader", { name: /remaining balance/i })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
    expect(within(screen.getAllByRole("row")[1]!).getAllByRole("cell")[4]).toHaveTextContent("$0.00");
  });

  it("print button triggers window.print", () => {
    const print = jest.spyOn(window, "print").mockImplementation(() => {});
    render(<RepaymentScheduleTable amortization={amortization} showSummaryCards={false} />);
    fireEvent.click(screen.getByRole("button", { name: /print schedule/i }));
    expect(print).toHaveBeenCalledTimes(1);
  });
});
