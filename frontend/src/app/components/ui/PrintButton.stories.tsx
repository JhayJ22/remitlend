import type { Meta, StoryObj } from "@storybook/react";
import { PrintButton } from "./PrintButton";

const meta = {
  title: "UI/PrintButton",
  component: PrintButton,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component:
          "Opens the browser print dialog. Print output is shaped by the `@media print` rules in `globals.css`: app chrome is hidden, cards are flattened, and charts are kept whole across page breaks.",
      },
    },
  },
} satisfies Meta<typeof PrintButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const CustomLabel: Story = {
  args: { label: "Print report", documentTitle: "RemitLend - Yield Report" },
};
