import type { Meta, StoryObj } from "@storybook/react";
import { RepaymentScheduleTable } from "./RepaymentScheduleTable";
import type { LoanAmortization } from "../../hooks/useApi";

const base: LoanAmortization = {
  principal: 900,
  interestRateBps: 1200,
  termLedgers: 17280 * 90,
  totalInterest: 108,
  totalDue: 1008,
  schedule: [
    { date: "2026-01-01T00:00:00Z", principalPortion: 300, interestPortion: 36, totalDue: 336, runningBalance: 600 },
    { date: "2026-02-01T00:00:00Z", principalPortion: 300, interestPortion: 36, totalDue: 336, runningBalance: 300 },
    { date: "2026-03-01T00:00:00Z", principalPortion: 300, interestPortion: 36, totalDue: 336, runningBalance: 0 },
  ],
};

const meta = {
  title: "Loan Wizard/RepaymentScheduleTable",
  component: RepaymentScheduleTable,
  tags: ["autodocs"],
} satisfies Meta<typeof RepaymentScheduleTable>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Interest, principal and balance columns; fees are zero. */
export const Default: Story = { args: { amortization: base } };

/** Every column populated, including a fee component per payment. */
export const WithFees: Story = {
  args: {
    amortization: {
      ...base,
      totalDue: 1017,
      schedule: base.schedule.map((r) => ({
        ...r,
        feePortion: 3,
        totalDue: r.totalDue + 3,
      })),
    },
  },
};

export const Compact: Story = { args: { amortization: base, compact: true, showSummaryCards: false } };

export const Empty: Story = { args: { amortization: { ...base, schedule: [] } } };
