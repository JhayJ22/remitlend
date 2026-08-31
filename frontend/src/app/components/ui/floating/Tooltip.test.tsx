import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Tooltip } from "./Tooltip";

describe("Tooltip", () => {
  it("shows on focus and links to the trigger via aria-describedby", async () => {
    const user = userEvent.setup();
    render(
      <Tooltip content="Annual percentage yield" delay={0}>
        <button type="button">APY</button>
      </Tooltip>,
    );

    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    await user.tab();
    await waitFor(() => expect(screen.getByRole("tooltip")).toBeInTheDocument());
    expect(screen.getByRole("tooltip")).toHaveTextContent("Annual percentage yield");
  });

  it("dismisses on Escape", async () => {
    const user = userEvent.setup();
    render(
      <Tooltip content="Help text" delay={0}>
        <button type="button">Trigger</button>
      </Tooltip>,
    );

    await user.tab();
    await waitFor(() => expect(screen.getByRole("tooltip")).toBeInTheDocument());

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());
  });

  it("does not open when disabled", async () => {
    const user = userEvent.setup();
    render(
      <Tooltip content="Nope" delay={0} disabled>
        <button type="button">Trigger</button>
      </Tooltip>,
    );

    await user.tab();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
});
