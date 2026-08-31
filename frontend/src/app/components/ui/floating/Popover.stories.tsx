import type { Meta, StoryObj } from "@storybook/react";
import { Popover } from "./Popover";

const meta = {
  title: "UI/Floating/Popover",
  component: Popover,
  tags: ["autodocs"],
  args: {
    ariaLabel: "Loan filters",
    trigger: (
      <span className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700">
        Open popover
      </span>
    ),
    children: (
      <div className="space-y-2">
        <p className="font-medium text-zinc-900 dark:text-zinc-100">Filter loans</p>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" defaultChecked /> Active
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" /> Repaid
        </label>
        <button
          type="button"
          className="mt-1 rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white"
        >
          Apply
        </button>
      </div>
    ),
  },
  parameters: { layout: "centered" },
} satisfies Meta<typeof Popover>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const TopPlacement: Story = { args: { placement: "top" } };
