/**
 * MaskedValue component tests (#838).
 *
 * Verifies that:
 * - When globalMask is false, the real value is shown in full
 * - When globalMask is true, the mask ("••••••••") is shown instead
 * - The real value is NOT in the DOM text when masked
 * - The accessible name (aria-label) does not contain the real value when masked
 * - The title attribute does not leak the value when masked
 * - The reveal toggle works: clicking it shows the real value
 * - The copy button is disabled when masked
 * - MaskedValueText renders the mask inline
 * - user-select: none style is applied when masked (screenshot protection)
 */

import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { render, screen, fireEvent } from "@testing-library/react";
import { MaskedValue, MaskedValueText } from "../MaskedValue";

const SECRET_VALUE = "$1,234.56";
const SECRET_ADDRESS = "GBORROWER123TESTADDRESS456STELLARWALLET789ABCDEFGHIJ";

// ── MaskedValue ───────────────────────────────────────────────────────────────

describe("MaskedValue", () => {
  describe("when globalMask is false (reduced-data mode off)", () => {
    it("renders the real value", () => {
      render(
        <MaskedValue
          value={SECRET_VALUE}
          globalMask={false}
          ariaLabel="Account balance"
        />,
      );
      expect(screen.getByText(SECRET_VALUE)).toBeInTheDocument();
    });

    it("does not render the mask", () => {
      render(
        <MaskedValue
          value={SECRET_VALUE}
          globalMask={false}
          ariaLabel="Account balance"
        />,
      );
      expect(screen.queryByText("••••••••")).not.toBeInTheDocument();
    });

    it("sets aria-label to the plain label (not 'hidden')", () => {
      render(
        <MaskedValue
          value={SECRET_VALUE}
          globalMask={false}
          ariaLabel="Account balance"
        />,
      );
      const span = screen.getByText(SECRET_VALUE);
      expect(span).toHaveAttribute("aria-label", "Account balance");
    });

    it("does not set user-select: none", () => {
      render(
        <MaskedValue
          value={SECRET_VALUE}
          globalMask={false}
          ariaLabel="Account balance"
        />,
      );
      const span = screen.getByText(SECRET_VALUE);
      // When not masked, there's no user-select style
      expect(span.style.userSelect).toBe("");
    });
  });

  describe("when globalMask is true (reduced-data mode on)", () => {
    it("renders the mask instead of the real value", () => {
      render(
        <MaskedValue
          value={SECRET_VALUE}
          globalMask={true}
          ariaLabel="Account balance"
        />,
      );
      expect(screen.getByText("••••••••")).toBeInTheDocument();
    });

    it("does NOT render the real value in the DOM", () => {
      render(
        <MaskedValue
          value={SECRET_VALUE}
          globalMask={true}
          ariaLabel="Account balance"
        />,
      );
      expect(screen.queryByText(SECRET_VALUE)).not.toBeInTheDocument();
    });

    it("sets aria-label to 'Account balance hidden' (not the real value)", () => {
      render(
        <MaskedValue
          value={SECRET_VALUE}
          globalMask={true}
          ariaLabel="Account balance"
        />,
      );
      const span = screen.getByText("••••••••");
      expect(span).toHaveAttribute("aria-label", "Account balance hidden");
    });

    it("aria-label does not contain the real value", () => {
      render(
        <MaskedValue
          value={SECRET_VALUE}
          globalMask={true}
          ariaLabel="Account balance"
        />,
      );
      const span = screen.getByText("••••••••");
      const ariaLabel = span.getAttribute("aria-label") ?? "";
      expect(ariaLabel).not.toContain(SECRET_VALUE);
      expect(ariaLabel).not.toContain("1234");
    });

    it("title attribute is 'Account balance hidden' (not the real value)", () => {
      render(
        <MaskedValue
          value={SECRET_VALUE}
          globalMask={true}
          ariaLabel="Account balance"
        />,
      );
      const span = screen.getByText("••••••••");
      expect(span).toHaveAttribute("title", "Account balance hidden");
    });

    it("sets user-select: none style (screenshot protection)", () => {
      render(
        <MaskedValue
          value={SECRET_VALUE}
          globalMask={true}
          ariaLabel="Account balance"
        />,
      );
      const span = screen.getByText("••••••••");
      expect(span.style.userSelect).toBe("none");
    });

    it("shows the reveal toggle button", () => {
      render(
        <MaskedValue
          value={SECRET_VALUE}
          globalMask={true}
          ariaLabel="Account balance"
        />,
      );
      expect(screen.getByRole("button", { name: "Reveal Account balance" })).toBeInTheDocument();
    });

    it("reveals the real value when the toggle is clicked", () => {
      render(
        <MaskedValue
          value={SECRET_VALUE}
          globalMask={true}
          ariaLabel="Account balance"
        />,
      );
      // Initially masked
      expect(screen.getByText("••••••••")).toBeInTheDocument();

      // Click reveal
      fireEvent.click(screen.getByRole("button", { name: "Reveal Account balance" }));

      // Now the real value is shown
      expect(screen.getByText(SECRET_VALUE)).toBeInTheDocument();
      expect(screen.queryByText("••••••••")).not.toBeInTheDocument();
    });

    it("re-masks when the toggle is clicked twice", () => {
      render(
        <MaskedValue
          value={SECRET_VALUE}
          globalMask={true}
          ariaLabel="Account balance"
        />,
      );

      // Reveal
      fireEvent.click(screen.getByRole("button", { name: "Reveal Account balance" }));
      expect(screen.getByText(SECRET_VALUE)).toBeInTheDocument();

      // Conceal
      fireEvent.click(screen.getByRole("button", { name: "Hide Account balance" }));
      expect(screen.getByText("••••••••")).toBeInTheDocument();
      expect(screen.queryByText(SECRET_VALUE)).not.toBeInTheDocument();
    });

    it("disables the copy button when masked", () => {
      render(
        <MaskedValue
          value={SECRET_VALUE}
          globalMask={true}
          ariaLabel="Account balance"
        />,
      );
      const copyButton = screen.getByRole("button", {
        name: "Copy Account balance disabled (hidden)",
      });
      expect(copyButton).toBeDisabled();
    });

    it("copy button aria-label does not contain the real value when masked", () => {
      render(
        <MaskedValue
          value={SECRET_VALUE}
          globalMask={true}
          ariaLabel="Account balance"
        />,
      );
      const copyButton = screen.getByRole("button", {
        name: "Copy Account balance disabled (hidden)",
      });
      const label = copyButton.getAttribute("aria-label") ?? "";
      expect(label).not.toContain(SECRET_VALUE);
      expect(label).not.toContain("1234");
    });

    it("enables the copy button after reveal", () => {
      render(
        <MaskedValue
          value={SECRET_VALUE}
          globalMask={true}
          ariaLabel="Account balance"
        />,
      );
      // Reveal
      fireEvent.click(screen.getByRole("button", { name: "Reveal Account balance" }));

      // Copy button should now be enabled
      const copyButton = screen.getByRole("button", { name: "Copy Account balance" });
      expect(copyButton).not.toBeDisabled();
    });
  });

  describe("with hideToggle=true", () => {
    it("does not show the reveal toggle", () => {
      render(
        <MaskedValue
          value={SECRET_VALUE}
          globalMask={true}
          ariaLabel="Account balance"
          hideToggle={true}
        />,
      );
      expect(screen.queryByRole("button", { name: /Reveal/ })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Hide/ })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Copy/ })).not.toBeInTheDocument();
    });
  });

  describe("with addresses (mono font)", () => {
    it("masks the address when globalMask is true", () => {
      render(
        <MaskedValue
          value={SECRET_ADDRESS}
          globalMask={true}
          ariaLabel="Wallet address"
          mono={true}
        />,
      );
      expect(screen.getByText("G••••••••")).toBeInTheDocument();
      expect(screen.queryByText(SECRET_ADDRESS)).not.toBeInTheDocument();
    });

    it("aria-label does not leak the address when masked", () => {
      render(
        <MaskedValue
          value={SECRET_ADDRESS}
          globalMask={true}
          ariaLabel="Wallet address"
          mono={true}
        />,
      );
      const span = screen.getByText("G••••••••");
      const label = span.getAttribute("aria-label") ?? "";
      expect(label).not.toContain(SECRET_ADDRESS);
      expect(label).not.toContain("GBORROWER");
    });
  });
});

// ── MaskedValueText ──────────────────────────────────────────────────────────

describe("MaskedValueText", () => {
  it("renders the real value when not masked", () => {
    render(
      <MaskedValueText
        value={SECRET_VALUE}
        globalMask={false}
        ariaLabel="Balance"
      />,
    );
    expect(screen.getByText(SECRET_VALUE)).toBeInTheDocument();
  });

  it("renders the mask when masked", () => {
    render(
      <MaskedValueText
        value={SECRET_VALUE}
        globalMask={true}
        ariaLabel="Balance"
      />,
    );
    expect(screen.getByText("••••••••")).toBeInTheDocument();
    expect(screen.queryByText(SECRET_VALUE)).not.toBeInTheDocument();
  });

  it("sets aria-label to 'Balance hidden' when masked", () => {
    render(
      <MaskedValueText
        value={SECRET_VALUE}
        globalMask={true}
        ariaLabel="Balance"
      />,
    );
    const span = screen.getByText("••••••••");
    expect(span).toHaveAttribute("aria-label", "Balance hidden");
  });

  it("sets user-select: none when masked", () => {
    render(
      <MaskedValueText
        value={SECRET_VALUE}
        globalMask={true}
        ariaLabel="Balance"
      />,
    );
    const span = screen.getByText("••••••••");
    expect(span.style.userSelect).toBe("none");
  });

  it("does not set user-select: none when not masked", () => {
    render(
      <MaskedValueText
        value={SECRET_VALUE}
        globalMask={false}
        ariaLabel="Balance"
      />,
    );
    const span = screen.getByText(SECRET_VALUE);
    expect(span.style.userSelect).toBe("");
  });
});
