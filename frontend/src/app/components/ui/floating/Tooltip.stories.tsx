import type { Meta, StoryObj } from "@storybook/react";
import { Tooltip } from "./Tooltip";
import type { Placement } from "./useFloating";

const meta = {
  title: "UI/Floating/Tooltip",
  component: Tooltip,
  tags: ["autodocs"],
  args: {
    content: "Annual percentage yield paid to lenders",
    placement: "top",
    children: (
      <button
        type="button"
        className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700"
      >
        Hover or focus me
      </button>
    ),
  },
  argTypes: {
    placement: {
      control: "select",
      options: [
        "top",
        "top-start",
        "top-end",
        "bottom",
        "bottom-start",
        "bottom-end",
        "left",
        "right",
      ] satisfies Placement[],
    },
  },
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof Tooltip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Bottom: Story = { args: { placement: "bottom" } };

export const NearViewportEdge: Story = {
  render: (args) => (
    <div className="flex w-full justify-end">
      <Tooltip {...args} />
    </div>
  ),
  parameters: {
    docs: {
      description: {
        story:
          "The positioning engine flips and shifts the tooltip so it never clips off-screen, even flush against the viewport edge.",
      },
    },
  },
};
