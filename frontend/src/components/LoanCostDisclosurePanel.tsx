import React from 'react';

export interface LoanCostBreakdown {
  principal: number;
  interestRate: number;
  originationFee: number;
  serviceFee: number;
  lateFee?: number;
  totalRepayment: number;
  currency?: string;
}

export interface LoanCostDisclosurePanelProps {
  breakdown: LoanCostBreakdown;
  disclosureVersion?: string;
  className?: string;
}

const formatAmount = (value: number, currency: string): string =>
  `${value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ${currency}`;

/**
 * Renders the full loan cost breakdown required by
 * docs/loan-cost-disclosure.md before a loan request is submitted.
 */
const LoanCostDisclosurePanel: React.FC<LoanCostDisclosurePanelProps> = ({
  breakdown,
  disclosureVersion,
  className,
}) => {
  const currency = breakdown.currency ?? 'USD';

  const rows: Array<{ label: string; value: string; emphasis?: boolean }> = [
    { label: 'Principal', value: formatAmount(breakdown.principal, currency) },
    {
      label: `Interest rate`,
      value: `${breakdown.interestRate.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}%`,
    },
    { label: 'Origination fee', value: formatAmount(breakdown.originationFee, currency) },
    { label: 'Service fee', value: formatAmount(breakdown.serviceFee, currency) },
  ];

  if (typeof breakdown.lateFee === 'number') {
    rows.push({ label: 'Late fee', value: formatAmount(breakdown.lateFee, currency) });
  }

  rows.push({
    label: 'Total repayment',
    value: formatAmount(breakdown.totalRepayment, currency),
    emphasis: true,
  });

  return (
    <section
      className={className}
      aria-labelledby="loan-cost-disclosure-heading"
      data-testid="loan-cost-disclosure-panel"
    >
      <h3 id="loan-cost-disclosure-heading">Loan Cost Disclosure</h3>
      <p>
        Review the full cost of this loan before submitting your request. All amounts are shown in{' '}
        {currency}.
      </p>
      <dl>
        {rows.map((row) => (
          <div key={row.label} data-testid={`loan-cost-row-${row.label.toLowerCase().replace(/\s+/g, '-')}`}>
            <dt>{row.label}</dt>
            <dd style={row.emphasis ? { fontWeight: 600 } : undefined}>{row.value}</dd>
          </div>
        ))}
      </dl>
      {disclosureVersion ? (
        <p data-testid="loan-cost-disclosure-version">
          Disclosure version: {disclosureVersion}
        </p>
      ) : null}
    </section>
  );
};

export default LoanCostDisclosurePanel;
