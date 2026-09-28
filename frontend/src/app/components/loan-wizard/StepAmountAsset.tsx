"use client";

import { useMemo } from "react";
import { HandCoins, CircleAlert } from "lucide-react";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/Card";
import type { LoanWizardData } from "./LoanApplicationWizard";
import {
  buildAmountHelperText,
  getPrecisionError,
  sanitizeAmountInput,
  formatAmountOnBlur,
  getAssetDecimals,
} from "../../utils/amount";
import {
  computeLoanCostDisclosure,
  DEFAULT_LOAN_ANNUAL_RATE_BPS,
  formatBps,
  formatDisclosureAmount,
  isZeroAmount,
} from "../../utils/loanCostDisclosure";

const TERM_OPTIONS = [
  { label: "30 days", days: 30 as const },
  { label: "60 days", days: 60 as const },
  { label: "90 days", days: 90 as const },
];

const ASSETS = [
  { value: "USDC", label: "USDC", description: "USD Coin — Stellar Testnet" },
] as const;

function getScoreBandLabel(score: number): string {
  if (score >= 750) return "Excellent";
  if (score >= 670) return "Good";
  if (score >= 580) return "Fair";
  if (score >= 500) return "Poor";
  return "Below minimum";
}

function formatMoney(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

interface StepAmountAssetProps {
  data: LoanWizardData;
  onChange: (updates: Partial<LoanWizardData>) => void;
  onNext: () => void;
  error: string | null;
  onError: (msg: string | null) => void;
}

export function StepAmountAsset({ data, onChange, onNext, error, onError }: StepAmountAssetProps) {
  const amountNumber = Number(data.amount || "0");
  const minAmount = 100;
  const asset = data.asset || "USDC";
  const decimals = getAssetDecimals(asset);
  const precisionError = getPrecisionError(data.amount, asset);
  const helperText = buildAmountHelperText(data.amount, asset, decimals);

  /**
   * Live cost preview. It uses the same disclosure engine as the signature
   * step, so the number the borrower sees while choosing an amount is the same
   * arithmetic that will appear before signing.
   */
  const cost = useMemo(
    () =>
      computeLoanCostDisclosure({
        principal: data.amount,
        asset,
        termDays: data.termDays,
        annualRateBps: Number(DEFAULT_LOAN_ANNUAL_RATE_BPS),
        lateFeeBps: 50,
        networkFee: { amount: "0.00001", asset: "XLM" },
      }),
    [data.amount, asset, data.termDays],
  );
  const preview = cost.ok ? cost.disclosure : null;

  const validate = (): boolean => {
    if (!data.amount || Number.isNaN(amountNumber) || amountNumber <= 0) {
      onError("Enter a valid loan amount.");
      return false;
    }
    if (precisionError) {
      onError(precisionError);
      return false;
    }
    if (data.maxAmount === 0) {
      onError("Your credit score is below 500 and is not eligible for a loan.");
      return false;
    }
    if (amountNumber < minAmount) {
      onError(`Minimum request amount is ${formatMoney(minAmount)}.`);
      return false;
    }
    if (amountNumber > data.maxAmount) {
      onError(`Maximum eligible amount for your score is ${formatMoney(data.maxAmount)}.`);
      return false;
    }
    if (!cost.ok) {
      onError(cost.error.message);
      return false;
    }
    onError(null);
    return true;
  };

  const handleContinue = () => {
    if (validate()) onNext();
  };

  const scoreBandLabel = getScoreBandLabel(data.creditScore);

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Left: Inputs */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <HandCoins className="h-5 w-5 text-indigo-500" />
              Loan Details
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            {/* Asset selector */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Asset</label>
              <div className="flex flex-col gap-2">
                {ASSETS.map((asset) => (
                  <button
                    key={asset.value}
                    type="button"
                    onClick={() => onChange({ asset: asset.value })}
                    className="flex items-center gap-3 rounded-lg border border-indigo-500 bg-indigo-50 px-4 py-3 text-left transition dark:bg-indigo-500/10"
                    aria-pressed={data.asset === asset.value}
                  >
                    <span className="flex h-8 w-8 items-center justify-center rounded-full bg-indigo-600 text-xs font-bold text-white">
                      {asset.value[0]}
                    </span>
                    <div>
                      <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
                        {asset.label}
                      </p>
                      <p className="text-xs text-zinc-500 dark:text-zinc-400">
                        {asset.description}
                      </p>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* Amount */}
            <Input
              label={`Amount (${asset})`}
              type="text"
              inputMode="decimal"
              min={minAmount}
              max={data.maxAmount || undefined}
              step={Math.pow(10, -decimals)}
              value={data.amount}
              onChange={(e) => {
                onChange({ amount: sanitizeAmountInput(e.target.value) });
                onError(null);
              }}
              onBlur={(e) => {
                const formatted = formatAmountOnBlur(e.target.value, asset);
                if (formatted && formatted !== e.target.value) {
                  onChange({ amount: formatted });
                }
              }}
              placeholder="1000"
              required
              helperText={
                precisionError ||
                helperText ||
                (data.maxAmount === 0
                  ? "Not eligible"
                  : `Eligible range: ${formatMoney(minAmount)} – ${formatMoney(
                      data.maxAmount,
                    )} • Max ${decimals} decimal places`)
              }
              error={precisionError || undefined}
            />

            {/* Term */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                Repayment Term <span className="text-red-500">*</span>
              </label>
              <div className="grid grid-cols-3 gap-2">
                {TERM_OPTIONS.map((option) => (
                  <button
                    key={option.days}
                    type="button"
                    onClick={() => onChange({ termDays: option.days })}
                    className={`rounded-lg border px-3 py-2 text-sm font-medium transition ${
                      data.termDays === option.days
                        ? "border-indigo-500 bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300"
                        : "border-zinc-300 text-zinc-700 dark:border-zinc-700 dark:text-zinc-300"
                    }`}
                    aria-pressed={data.termDays === option.days}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            {error && (
              <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
                <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                {error}
              </div>
            )}

            <p className="text-[10px] text-zinc-500 dark:text-zinc-400 mt-2">
              <span className="text-red-600">*</span> Required field
            </p>

            <Button onClick={handleContinue} className="w-full">
              Continue to Repayment Schedule
            </Button>
          </CardContent>
        </Card>

        {/* Right: Eligibility summary */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Eligibility Summary</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <div className="rounded-lg bg-zinc-50 p-4 dark:bg-zinc-900">
              <p className="text-zinc-500 dark:text-zinc-400">Credit Score</p>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="text-2xl font-bold text-zinc-900 dark:text-zinc-50">
                  {data.creditScore}
                </span>
                <span className="text-sm font-medium text-indigo-600 dark:text-indigo-400">
                  {scoreBandLabel}
                </span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                <p className="text-zinc-500 dark:text-zinc-400">Max Eligible</p>
                <p className="font-semibold text-zinc-900 dark:text-zinc-50">
                  {data.maxAmount === 0 ? "Ineligible" : formatMoney(data.maxAmount)}
                </p>
              </div>
              <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                <p className="text-zinc-500 dark:text-zinc-400">APR</p>
                <p className="font-semibold text-zinc-900 dark:text-zinc-50">
                  {formatBps(Number(DEFAULT_LOAN_ANNUAL_RATE_BPS))}
                </p>
                {preview && (
                  <p
                    data-testid="step-amount-asset-effective-apr"
                    className="text-[11px] text-zinc-500 dark:text-zinc-400"
                  >
                    {formatBps(preview.effectiveAprBps)} once fees are included
                  </p>
                )}
              </div>
            </div>

            {preview && (
              <div
                data-testid="step-amount-asset-cost-preview"
                className="space-y-2 rounded-lg border border-indigo-200 bg-indigo-50 p-4 dark:border-indigo-900/50 dark:bg-indigo-950/30"
              >
                <p className="text-sm font-semibold text-indigo-900 dark:text-indigo-200">
                  Cost preview for {data.termDays} days
                </p>
                <dl className="space-y-1 text-xs text-indigo-900 dark:text-indigo-200">
                  <div className="flex justify-between">
                    <dt>Interest over the term</dt>
                    <dd className="font-medium">
                      {formatDisclosureAmount(preview.interest, preview.asset)}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt>Upfront fees</dt>
                    <dd className="font-medium">
                      {isZeroAmount(preview.upfrontFees, preview.decimals)
                        ? "None"
                        : formatDisclosureAmount(preview.upfrontFees, preview.asset)}
                    </dd>
                  </div>
                  <div className="flex justify-between border-t border-indigo-200 pt-1 dark:border-indigo-900/50">
                    <dt className="font-semibold">Total you repay</dt>
                    <dd data-testid="step-amount-asset-total-repayment" className="font-bold">
                      {formatDisclosureAmount(preview.totalRepayment, preview.asset)}
                    </dd>
                  </div>
                </dl>
                <p className="text-[11px] text-indigo-800/80 dark:text-indigo-300/80">
                  A full itemised disclosure is shown before you sign.
                </p>
              </div>
            )}

            <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
              <p className="font-medium text-zinc-700 dark:text-zinc-300">How eligibility works</p>
              <ul className="mt-2 space-y-1 text-xs text-zinc-500 dark:text-zinc-400">
                <li>• Score 750+ → up to $50,000</li>
                <li>• Score 670–749 → up to $25,000</li>
                <li>• Score 580–669 → up to $10,000</li>
                <li>• Score 500–579 → up to $5,000</li>
                <li>• Score below 500 → not eligible</li>
              </ul>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
