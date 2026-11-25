import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ActionableError } from "./ActionableError";

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => {
    const messages = require(`${process.cwd()}/messages/en.json`);
    const value = key.split(".").reduce<unknown>((current, part) => {
      if (current && typeof current === "object") return (current as Record<string, unknown>)[part];
      return undefined;
    }, messages);
    return typeof value === "string" ? value : `missing:${key}`;
  },
}));

describe("ActionableError", () => {
  it("renders localized guidance with the unchanged code and reference ID", async () => {
    const onReauthenticate = jest.fn();
    const user = userEvent.setup();
    render(
      <ActionableError
        error={{
          error: {
            code: "TOKEN_EXPIRED",
            referenceId: "REF-9f2c",
            message: "internal postgres host db-17",
          },
        }}
        onReauthenticate={onReauthenticate}
      />,
    );

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Session needs attention" })).toBeInTheDocument();
    expect(screen.getByText("Your secure session is no longer active.")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Sign in again to continue. Do not repeat a payment until you see its final status.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("TOKEN_EXPIRED")).toBeInTheDocument();
    expect(screen.getByText("REF-9f2c")).toBeInTheDocument();
    expect(screen.queryByText(/postgres/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Sign in again" }));
    expect(onReauthenticate).toHaveBeenCalledTimes(1);
  });

  it("offers a retry action only for retryable errors", async () => {
    const onRetry = jest.fn();
    const user = userEvent.setup();
    const { unmount } = render(
      <ActionableError error={{ code: "RATE_LIMIT_EXCEEDED" }} onRetry={onRetry} />,
    );

    expect(screen.getByRole("heading", { name: "Please slow down" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    unmount();

    render(<ActionableError error={{ code: "FORBIDDEN" }} onRetry={onRetry} />);
    expect(screen.getByRole("heading", { name: "Access restricted" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("uses safe fallback copy for unknown codes", () => {
    render(<ActionableError error={{ code: "FUTURE_BACKEND_CODE", message: "stack trace" }} />);
    expect(screen.getByRole("heading", { name: "Unexpected error" })).toBeInTheDocument();
    expect(screen.getByText("FUTURE_BACKEND_CODE")).toBeInTheDocument();
    expect(screen.queryByText(/stack trace/)).not.toBeInTheDocument();
  });
});
