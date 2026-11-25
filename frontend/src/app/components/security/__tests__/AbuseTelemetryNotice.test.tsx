import { render, screen } from "@testing-library/react";
import { AbuseTelemetryNotice } from "../AbuseTelemetryNotice";

describe("AbuseTelemetryNotice", () => {
  it("states the user-visible assumptions without raw PII or wallet secrets", () => {
    render(<AbuseTelemetryNotice />);

    expect(screen.getByTestId("abuse-telemetry-notice")).toBeInTheDocument();
    expect(screen.getByTestId("abuse-telemetry-notice-collected")).toHaveTextContent(
      "succeeded or was blocked",
    );
    expect(screen.getByTestId("abuse-telemetry-notice-exclusions")).toHaveTextContent(
      "wallet address, keys, signed transactions, IP address, transaction amounts",
    );
    expect(screen.getByTestId("abuse-telemetry-notice-retention")).toHaveTextContent("30 days");
  });

  it("renders the configured retention period", () => {
    render(<AbuseTelemetryNotice retentionDays={7} />);

    expect(screen.getByTestId("abuse-telemetry-notice-retention")).toHaveTextContent("7 days");
  });
});
