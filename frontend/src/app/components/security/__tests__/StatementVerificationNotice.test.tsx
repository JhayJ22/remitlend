import { render, screen } from "@testing-library/react";
import {
  StatementVerificationNotice,
  STATEMENT_VERIFICATION_ASSUMPTIONS,
} from "../StatementVerificationNotice";

describe("StatementVerificationNotice", () => {
  it("explains the signed manifest and privacy assumptions", () => {
    render(<StatementVerificationNotice />);

    expect(screen.getByTestId("statement-verification-notice")).toBeTruthy();
    expect(screen.getByTestId("statement-verification-summary").textContent).toContain(
      "signed manifest.json",
    );
    expect(screen.getByTestId("statement-verification-assumptions").children).toHaveLength(
      STATEMENT_VERIFICATION_ASSUMPTIONS.length,
    );
    expect(screen.getByText(/Stellar ledger remains the ultimate authority/)).toBeTruthy();
  });
});
