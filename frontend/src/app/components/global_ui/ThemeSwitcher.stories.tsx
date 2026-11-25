import type { Meta, StoryObj } from "@storybook/react";
import { ThemeSwitcher } from "./ThemeSwitcher";

const meta = {
  title: "Global UI/ThemeSwitcher",
  component: ThemeSwitcher,
  tags: ["autodocs"],
  parameters: {
    // Show the switcher on both a light and dark canvas background so the
    // dark-mode Tailwind variants are visible in Storybook.
    backgrounds: {
      default: "light",
      values: [
        { name: "light", value: "#ffffff" },
        { name: "dark", value: "#0D0D12" },
      ],
    },
  },
} satisfies Meta<typeof ThemeSwitcher>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Light: Story = {
  parameters: { backgrounds: { default: "light" } },
};

export const Dark: Story = {
  parameters: { backgrounds: { default: "dark" } },
};

export const System: Story = {
  // "System" renders the same control; the resolved theme depends on the
  // browser's prefers-color-scheme at runtime.
  parameters: { backgrounds: { default: "light" } },
};

export const AllModes: Story = {
  render: () => (
    <div className="flex flex-col gap-6 p-6">
      <div>
        <p className="mb-2 text-sm font-medium text-zinc-700">Light canvas</p>
        <ThemeSwitcher />
      </div>
      <div>
        <p className="mb-2 text-sm font-medium text-zinc-700">Dark canvas</p>
        <ThemeSwitcher />
      </div>
      <div>
        <p className="mb-2 text-sm font-medium text-zinc-700">Inline (with className)</p>
        <ThemeSwitcher className="border border-zinc-200 dark:border-zinc-700" />
      </div>
    </div>
  ),
};
