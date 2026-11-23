import type { Meta, StoryObj } from "@storybook/react";
import { NextIntlClientProvider } from "next-intl";
import en from "../../../../messages/en.json";
import { GlossaryTerm, GLOSSARY_TERM_KEYS } from "./GlossaryTerm";

/**
 * Stories for GlossaryTerm — the contextual inline term explanation.
 *
 * All stories wrap the component in NextIntlClientProvider so the
 * Glossary namespace translations are available without a real Next.js
 * request context.
 */
function withIntl(Story: React.ComponentType) {
  return (
    <NextIntlClientProvider locale="en" messages={en}>
      <Story />
    </NextIntlClientProvider>
  );
}

const meta = {
  title: "Glossary/GlossaryTerm",
  component: GlossaryTerm,
  tags: ["autodocs"],
  decorators: [withIntl],
  parameters: { layout: "centered" },
  args: {
    termKey: "apr",
  },
  argTypes: {
    termKey: {
      control: "select",
      options: GLOSSARY_TERM_KEYS,
    },
    variant: {
      control: "radio",
      options: ["icon", "inline"],
    },
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
      ],
    },
  },
} satisfies Meta<typeof GlossaryTerm>;

export default meta;
type Story = StoryObj<typeof meta>;

export const IconVariant: Story = {
  args: { variant: "icon" },
  render: (args) => (
    <NextIntlClientProvider locale="en" messages={en}>
      <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
        <GlossaryTerm {...args}>APR</GlossaryTerm>
      </span>
    </NextIntlClientProvider>
  ),
};

export const InlineVariant: Story = {
  args: { variant: "inline", termKey: "collateral" },
  render: (args) => (
    <NextIntlClientProvider locale="en" messages={en}>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Your{" "}
        <GlossaryTerm {...args} />{" "}
        value must remain above the liquidation threshold.
      </p>
    </NextIntlClientProvider>
  ),
};

export const AllTerms: Story = {
  render: () => (
    <NextIntlClientProvider locale="en" messages={en}>
      <div className="grid gap-3 text-sm">
        {GLOSSARY_TERM_KEYS.map((key) => (
          <div key={key} className="flex items-center gap-2">
            <GlossaryTerm termKey={key} variant="icon" />
          </div>
        ))}
      </div>
    </NextIntlClientProvider>
  ),
};

export const InLenderStatCard: Story = {
  render: () => (
    <NextIntlClientProvider locale="en" messages={en}>
      <div className="rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
        <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
          <GlossaryTerm termKey="apy" variant="icon">
            Current APY
          </GlossaryTerm>
        </p>
        <h3 className="mt-1 text-2xl font-bold text-zinc-900 dark:text-zinc-50">8.00%</h3>
      </div>
    </NextIntlClientProvider>
  ),
};

export const InDisclosureRow: Story = {
  render: () => (
    <NextIntlClientProvider locale="en" messages={en}>
      <div className="w-80 rounded-lg border border-zinc-200 overflow-hidden dark:border-zinc-800">
        {[
          { key: "principal" as const, label: "Principal", value: "$1,000.00" },
          { key: "originationFee" as const, label: "Origination fee", value: "$10.00" },
          { key: "interest" as const, label: "Interest", value: "$9.86" },
          { key: "effectiveApr" as const, label: "Effective APR", value: "13.14%" },
        ].map((row) => (
          <div
            key={row.key}
            className="flex items-baseline justify-between gap-4 px-4 py-2.5 text-sm border-b border-zinc-100 dark:border-zinc-800 last:border-0"
          >
            <span className="text-zinc-500 dark:text-zinc-400">
              <GlossaryTerm termKey={row.key} variant="inline">
                {row.label}
              </GlossaryTerm>
            </span>
            <span className="font-medium text-zinc-900 dark:text-zinc-50">{row.value}</span>
          </div>
        ))}
      </div>
    </NextIntlClientProvider>
  ),
};
