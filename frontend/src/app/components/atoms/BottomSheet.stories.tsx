import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { BottomSheet } from "./BottomSheet";

const meta = {
  title: "Atoms/BottomSheet",
  component: BottomSheet,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
    viewport: { defaultViewport: "mobile1" },
    docs: {
      description: {
        component:
          "Mobile drawer used by `Modal` below 768px. Swipe down on the handle, press Escape, tap the backdrop or the close button to dismiss. Focus is trapped while open.",
      },
    },
  },
  args: {
    isOpen: true,
    title: "Repay loan #42",
    onClose: () => {},
    children: null,
  },
} satisfies Meta<typeof BottomSheet>;

export default meta;
type Story = StoryObj<typeof meta>;

function RepayContent({ onClose }: { onClose: () => void }) {
  return (
    <div className="space-y-4">
      <label className="block text-sm font-medium text-gray-700 dark:text-zinc-300">
        Amount (USDC)
        <input
          type="number"
          inputMode="decimal"
          defaultValue="250.00"
          className="mt-1 w-full rounded-lg border border-gray-300 p-3 dark:border-zinc-700 dark:bg-zinc-900"
        />
      </label>
      <div className="flex gap-3">
        <button type="button" onClick={onClose} className="flex-1 rounded-lg border px-4 py-3">
          Cancel
        </button>
        <button type="button" className="flex-1 rounded-lg bg-indigo-600 px-4 py-3 text-white">
          Repay
        </button>
      </div>
    </div>
  );
}

export const Open: Story = {
  render: (args) => {
    const [open, setOpen] = useState(args.isOpen);
    return (
      <div className="min-h-screen p-4">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-white"
        >
          Open sheet
        </button>
        <BottomSheet {...args} isOpen={open} onClose={() => setOpen(false)}>
          <RepayContent onClose={() => setOpen(false)} />
        </BottomSheet>
      </div>
    );
  },
};

export const LongContent: Story = {
  render: (args) => {
    const [open, setOpen] = useState(args.isOpen);
    return (
      <div className="min-h-screen p-4">
        <button type="button" onClick={() => setOpen(true)}>
          Open sheet
        </button>
        <BottomSheet {...args} title="Refinance terms" isOpen={open} onClose={() => setOpen(false)}>
          <div className="space-y-3">
            {Array.from({ length: 30 }, (_, i) => (
              <p key={i} className="text-sm text-gray-600 dark:text-zinc-400">
                Term detail line {i + 1}
              </p>
            ))}
          </div>
        </BottomSheet>
      </div>
    );
  },
};
