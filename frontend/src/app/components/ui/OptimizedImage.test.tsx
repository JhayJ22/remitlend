import { render, screen } from "@testing-library/react";
import { OptimizedImage } from "./OptimizedImage";

describe("OptimizedImage", () => {
  it("marks above-the-fold images as priority and eager", () => {
    render(
      <OptimizedImage src="/images/logo.png" alt="RemitLend" width={32} height={32} priority />,
    );

    const image = screen.getByAltText("RemitLend");
    expect(image).toHaveAttribute("fetchpriority", "high");
    expect(image).toHaveAttribute("loading", "eager");
  });

  it("lazy-loads secondary images by default", () => {
    render(<OptimizedImage src="/images/logo.png" alt="RemitLend" width={32} height={32} />);

    expect(screen.getByAltText("RemitLend")).toHaveAttribute("loading", "lazy");
  });
});
