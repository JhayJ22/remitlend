"use client";

import { useMemo } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Card, CardHeader, CardTitle, CardContent } from "../ui/Card";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { TransactionPreviewModal } from "../transaction/TransactionPreviewModal";
import { useTransactionPreview } from "../../hooks/useTransactionPreview";
import { formatRemittanceSend } from "../../utils/transactionFormatter";
import { AlertCircle, Send, Loader } from "lucide-react";
import { useCreateRemittance, useRemittances } from "../../hooks/useApi";
import {
  buildAmountHelperText,
  parseAmount,
  sanitizeAmountInput,
  formatAmountOnBlur,
  getAssetDecimals,
} from "../../utils/amount";
import { useContractToast } from "../../hooks/useContractToast";
import {
  MEMO_MAX_LENGTH,
  REMITTANCE_FORM_DEFAULTS,
  REMITTANCE_TOKENS,
  remittanceSchema,
  type RemittanceFormValues,
} from "../../../lib/validation/remittance";

interface RemittanceFormProps {
  onSuccess?: () => void;
}

// A remittance counts as a duplicate if the same recipient/amount/token is
// still in flight (or was accepted moments ago). This is the async, server-data
// backed validation the ad-hoc version never had.
const DUPLICATE_WINDOW_MS = 5 * 60 * 1000;

export function RemittanceForm({ onSuccess }: RemittanceFormProps) {
  const txPreview = useTransactionPreview();
  const mutation = useCreateRemittance();
  const toast = useContractToast();
  const { data: existingRemittances } = useRemittances();

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    setError,
    clearErrors,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<RemittanceFormValues>({
    resolver: zodResolver(remittanceSchema),
    mode: "onBlur",
    defaultValues: REMITTANCE_FORM_DEFAULTS,
  });

  const amount = watch("amount");
  const token = watch("token");
  const memo = watch("memo") ?? "";
  const recipientAddress = watch("recipientAddress");

  const decimals = getAssetDecimals(token);
  const helperText = buildAmountHelperText(amount, token, decimals);

  const isBusy = mutation.isPending || isSubmitting;

  const errorSummary = useMemo(
    () =>
      Object.entries(errors)
        .filter(([key]) => key !== "root")
        .map(([key, value]) => ({ key, message: value?.message }))
        .filter((entry): entry is { key: string; message: string } => Boolean(entry.message)),
    [errors],
  );

  const findDuplicate = (values: RemittanceFormValues) => {
    const numAmount = parseAmount(values.amount);
    return (existingRemittances ?? []).find((remittance) => {
      const sameTarget =
        remittance.recipientAddress === values.recipientAddress.trim() &&
        remittance.fromCurrency === values.token &&
        Math.abs(remittance.amount - numAmount) < Number.EPSILON;
      if (!sameTarget) return false;
      if (remittance.status === "pending" || remittance.status === "processing") return true;
      return Date.now() - new Date(remittance.createdAt).getTime() < DUPLICATE_WINDOW_MS;
    });
  };

  const submitRemittance = async (values: RemittanceFormValues) => {
    const numAmount = parseAmount(values.amount);
    try {
      await mutation.mutateAsync({
        amount: numAmount,
        fromCurrency: values.token,
        toCurrency: values.token,
        recipientAddress: values.recipientAddress.trim(),
        memo: values.memo ? values.memo : undefined,
      });

      toast.success("Success!", "Remittance sent successfully");
      reset(REMITTANCE_FORM_DEFAULTS);
      onSuccess?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to send remittance";
      toast.error("Error", message);
      setError("root", { type: "server", message });
    }
  };

  const onValid = async (values: RemittanceFormValues) => {
    clearErrors("root");

    const duplicate = findDuplicate(values);
    if (duplicate) {
      setError("root", {
        type: "duplicate",
        message:
          "A matching remittance to this recipient is already pending or was just sent. Wait for it to settle before retrying.",
      });
      toast.error("Possible duplicate", "This remittance looks identical to a recent one.");
      return;
    }

    const previewData = formatRemittanceSend({
      amount: parseAmount(values.amount),
      recipient: values.recipientAddress.trim(),
      token: values.token,
    });

    txPreview.show(previewData, () => submitRemittance(values));
  };

  const onInvalid = () => {
    toast.error("Validation Error", "Please fix the highlighted fields before continuing");
  };

  const rootError = errors.root?.message;

  return (
    <>
      <form className="space-y-6" onSubmit={handleSubmit(onValid, onInvalid)} noValidate>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Send className="h-5 w-5" />
              Send Remittance
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            {(errorSummary.length > 0 || rootError) && (
              <div
                role="alert"
                className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
              >
                <p className="mb-1 flex items-center gap-2 font-semibold">
                  <AlertCircle className="h-4 w-4" />
                  Please fix the following
                </p>
                <ul className="list-inside list-disc space-y-1">
                  {rootError && <li>{rootError}</li>}
                  {errorSummary.map((entry) => (
                    <li key={entry.key}>{entry.message}</li>
                  ))}
                </ul>
              </div>
            )}

            <Input
              id="recipientAddress"
              label="Recipient Address"
              placeholder="G... (Stellar public key)"
              disabled={isBusy}
              required
              error={errors.recipientAddress?.message}
              helperText="Enter the recipient's Stellar public key (56 characters starting with G)"
              {...register("recipientAddress")}
            />

            {/* Token Selection */}
            <div className="space-y-2">
              <label
                htmlFor="token"
                className="block text-sm font-semibold text-zinc-900 dark:text-zinc-50"
              >
                Token <span className="text-red-600">*</span>
              </label>
              <select
                id="token"
                disabled={isBusy}
                className="w-full px-3 py-2 border border-zinc-300 rounded-lg bg-white dark:bg-zinc-900 dark:border-zinc-700 text-zinc-900 dark:text-zinc-50 focus:outline-none focus:ring-2 focus:ring-indigo-600 dark:focus:ring-indigo-400"
                {...register("token")}
              >
                {REMITTANCE_TOKENS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
              {errors.token?.message ? (
                <p className="text-sm text-red-600">{errors.token.message}</p>
              ) : (
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  Select the currency for remittance
                </p>
              )}
            </div>

            <Input
              id="amount"
              label="Amount"
              type="text"
              inputMode="decimal"
              placeholder="0.00"
              step={Math.pow(10, -decimals)}
              value={amount}
              onChange={(e) =>
                setValue("amount", sanitizeAmountInput(e.target.value), {
                  shouldValidate: Boolean(errors.amount),
                })
              }
              onBlur={(e) => {
                const formatted = formatAmountOnBlur(e.target.value, token);
                setValue("amount", formatted && formatted !== e.target.value ? formatted : e.target.value, {
                  shouldValidate: true,
                });
              }}
              disabled={isBusy}
              required
              min="0"
              error={errors.amount?.message}
              helperText={helperText ?? `Up to ${decimals} decimal places supported.`}
              className={errors.amount ? "border-red-600" : ""}
            />

            <p className="text-[10px] text-zinc-500 dark:text-zinc-400 mt-2">
              <span className="text-red-600">*</span> Required field
            </p>

            {/* Memo (Optional) */}
            <div className="space-y-2">
              <label
                htmlFor="memo"
                className="block text-sm font-semibold text-zinc-900 dark:text-zinc-50"
              >
                Memo <span className="text-zinc-400">(optional)</span>
              </label>
              <textarea
                id="memo"
                placeholder={`Add a note for the recipient (max ${MEMO_MAX_LENGTH} characters)`}
                disabled={isBusy}
                maxLength={MEMO_MAX_LENGTH}
                rows={2}
                className={`w-full px-3 py-2 border rounded-lg bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-50 focus:outline-none focus:ring-2 focus:ring-indigo-600 dark:focus:ring-indigo-400 resize-none dark:border-zinc-700 ${
                  errors.memo ? "border-red-600" : "border-zinc-300"
                }`}
                {...register("memo")}
              />
              {errors.memo?.message && (
                <div className="flex items-start gap-2 text-sm text-red-600">
                  <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                  <span>{errors.memo.message}</span>
                </div>
              )}
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                {memo.length}/{MEMO_MAX_LENGTH} characters
              </p>
            </div>

            {/* Warning Box */}
            <div className="mt-6 p-4 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg">
              <div className="flex gap-3">
                <AlertCircle className="h-5 w-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                <div className="text-sm text-amber-800 dark:text-amber-300">
                  <p className="font-semibold mb-1">Before sending:</p>
                  <ul className="list-disc list-inside space-y-1 text-xs">
                    <li>Double-check the recipient address</li>
                    <li>Review the transaction preview</li>
                    <li>Confirm you have sufficient balance</li>
                  </ul>
                </div>
              </div>
            </div>

            {/* Action Buttons */}
            <div className="flex gap-3 pt-4">
              <Button type="submit" disabled={isBusy || !recipientAddress || !amount} className="flex-1">
                {isBusy ? (
                  <div role="status" className="flex items-center">
                    <Loader className="h-4 w-4 mr-2 animate-spin" />
                    Processing...
                  </div>
                ) : (
                  <>
                    <Send className="h-4 w-4 mr-2" />
                    Review & Send
                  </>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Information Card */}
        <Card className="bg-indigo-50 dark:bg-indigo-950/30 border-indigo-200 dark:border-indigo-800">
          <CardContent className="pt-6">
            <h3 className="font-semibold text-indigo-900 dark:text-indigo-300 mb-3">
              About Remittances
            </h3>
            <ul className="space-y-2 text-sm text-indigo-800 dark:text-indigo-400">
              <li className="flex gap-2">
                <span className="font-bold">•</span>
                <span>Remittances help build your credit score</span>
              </li>
              <li className="flex gap-2">
                <span className="font-bold">•</span>
                <span>Funds are secured on the Stellar blockchain</span>
              </li>
              <li className="flex gap-2">
                <span className="font-bold">•</span>
                <span>Transactions are typically confirmed within seconds</span>
              </li>
            </ul>
          </CardContent>
        </Card>
      </form>

      <TransactionPreviewModal
        isOpen={txPreview.isOpen}
        onClose={txPreview.close}
        onConfirm={txPreview.confirm}
        data={txPreview.data || { operations: [], balanceChanges: [], network: "Stellar Testnet" }}
        isLoading={mutation.isPending}
      />
    </>
  );
}
