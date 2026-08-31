import { render, screen } from "@testing-library/react";
import { Skeleton } from "../ui/Skeleton";
import { AnalyticsSkeleton } from "./AnalyticsSkeleton";
import { RemittanceHistorySkeleton } from "./RemittanceHistorySkeleton";
import { RepaymentFormSkeleton } from "./RepaymentFormSkeleton";
import { ActivitySkeleton } from "./ActivitySkeleton";

describe("frontend skeleton screens", () => {
  it("renders a shimmering skeleton base with accessible loading semantics", () => {
    render(<Skeleton className="h-8 w-20" data-testid="skeleton" />);

    expect(screen.getByTestId("skeleton")).toBeInTheDocument();
    expect(screen.getByTestId("skeleton")).toHaveClass("animate-shimmer");
  });

  it("renders the analytics, remittance, repayment, and activity skeletons", () => {
    const { rerender } = render(<AnalyticsSkeleton />);
    expect(screen.getByRole("status", { name: /loading analytics dashboard/i })).toBeInTheDocument();

    rerender(<RemittanceHistorySkeleton />);
    expect(screen.getByRole("status", { name: /loading remittance history/i })).toBeInTheDocument();

    rerender(<RepaymentFormSkeleton />);
    expect(screen.getByRole("status", { name: /loading repayment form/i })).toBeInTheDocument();

    rerender(<ActivitySkeleton />);
    expect(screen.getByRole("status", { name: /loading activity feed/i })).toBeInTheDocument();
  });
});
