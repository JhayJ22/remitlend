import { render, screen, fireEvent } from "@testing-library/react";
import { ProtocolAnalytics, protocolStatsToCsv } from "./ProtocolAnalytics";

const stats = {
  from: "2026-01-01T00:00:00.000Z",
  to: "2026-02-01T00:00:00.000Z",
  bucket: "day" as const,
  loansByStatus: { active: 3, defaulted: 1 },
  volumeByBucket: [{ timestamp: "2026-01-01T00:00:00.000Z", totalOriginated: "100.5", totalRepaid: "10" }],
  defaultRateByCorridor: { "USD-NGN": 0.25 },
  scoreDistribution: [{ bucket: "300-499", count: 2 }],
};

const mockHook = jest.fn();
jest.mock("../../hooks/useApi", () => ({ useProtocolStats: (d: number) => mockHook(d) }));
jest.mock("recharts", () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return new Proxy({}, { get: () => Pass });
});

describe("ProtocolAnalytics", () => {
  beforeEach(() => mockHook.mockReset());

  it("renders four labelled charts", () => {
    mockHook.mockReturnValue({ data: stats, isLoading: false, isError: false });
    render(<ProtocolAnalytics />);
    expect(screen.getAllByRole("img")).toHaveLength(4);
    expect(screen.getByLabelText(/histogram of borrower credit scores/i)).toBeTruthy();
  });

  it("date range filter refetches with the chosen window", () => {
    mockHook.mockReturnValue({ data: stats, isLoading: false, isError: false });
    render(<ProtocolAnalytics />);
    fireEvent.click(screen.getByText("Last 90 days"));
    expect(mockHook).toHaveBeenLastCalledWith(90);
    fireEvent.click(screen.getByText("Last 365 days"));
    expect(mockHook).toHaveBeenLastCalledWith(365);
  });

  it("shows loading and error states", () => {
    mockHook.mockReturnValue({ data: undefined, isLoading: true, isError: false });
    const { rerender } = render(<ProtocolAnalytics />);
    expect(screen.getByRole("status")).toBeTruthy();
    mockHook.mockReturnValue({ data: undefined, isLoading: false, isError: true, refetch: jest.fn() });
    rerender(<ProtocolAnalytics />);
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("CSV has correct headers and data", () => {
    const lines = protocolStatsToCsv(stats).split("\n");
    expect(lines[0]).toBe('"section","label","value","value2"');
    expect(lines).toContain('"loansByStatus","active","3",""');
    expect(lines).toContain('"volumeByBucket","2026-01-01T00:00:00.000Z","100.5","10"');
    expect(lines).toContain('"defaultRateByCorridor","USD-NGN","0.25",""');
    expect(lines).toContain('"scoreDistribution","300-499","2",""');
  });
});
