"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import { signTransaction } from "@stellar/freighter-api";
import { submitLoanTransaction } from "../../../hooks/useApi";
import { Button } from "../../../components/ui/Button";
import {
  TransactionStatusTracker,
  type TransactionStatusState,
} from "../../../components/ui/TransactionStatusTracker";
import { TransactionRecoveryPanel } from "../../../components/transaction/TransactionRecoveryPanel";
import {
  mapTransactionError,
  type TransactionErrorDetails,
} from "../../../utils/transactionErrors";
import {
  planRecoveryFromDetails,
  type RecoveryActionId,
  type TransactionRecoveryPlan,
} from "../../../utils/transactionRecovery";
import {
  selectIsWalletConnected,
  selectWalletAddress,
  useWalletStore,
} from "../../../stores/useWalletStore";
import { useContractToast } from "../../../hooks/useContractToast";
import { TransactionPreviewModal } from "../../../components/transaction/TransactionPreviewModal";
import { RepaymentFormSkeleton } from "../../../components/skeletons/RepaymentFormSkeleton";
import { useTransactionPreview } from "../../../hooks/useTransactionPreview";
import {
  buildAmountHelperText,
  getPrecisionError,
  sanitizeAmountInput,
  formatAmountOnBlur,
  getAssetDecimals,
} from "../../../utils/amount";
import { STELLAR_NETWORK_LABEL, STELLAR_NETWORK_PASSPHRASE } from "../../../utils/stellarNetwork";

export default function RepayLoanPage() {
  const params = useParams<{ loanId: string }>();
  const loanId = params?.loanId ?? "unknown";
  const router = useRouter();

  const walletAddress = useWalletStore(selectWalletAddress);
  const isWalletConnected = useWalletStore(selectIsWalletConnected);
  const toast = useContractToast();
  const txPreview = useTransactionPreview();

  const [amount, setAmount] = useState("250");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [trackerState, setTrackerState] = useState<TransactionStatusState>("idle");
  const [trackerTitle, setTrackerTitle] = useState("Ready to repay");
  const [initializing, setInitializing] = useState(true);
  const [trackerMessage, setTrackerMessage] = useState("");
  const [trackerGuidance, setTrackerGuidance] = useState<string | undefined>(undefined);
  const [trackerTxHash, setTrackerTxHash] = useState<string | null>(null);
  const [lastError, setLastError] = useState<TransactionErrorDetails | null>(null);
  const [recoveryPlan, setRecoveryPlan] = useState<TransactionRecoveryPlan | null>(null);

  const amountNumber = useMemo(() => Number(amount || "0"), [amount]);
  const decimals = getAssetDecimals("USDC");

  useEffect(() => {
    const timer = window.setTimeout(() => setInitializing(false), 150);
    return () => window.clearTimeout(timer);
  }, []);

  if (initializing) {
    return <RepaymentFormSkeleton />;
  }

  const precisionError = getPrecisionError(amount, "USDC");
  const helperText = buildAmountHelperText(amount, "USDC", decimals);

  const cancelFlow = () => {
    setTrackerState("cancelled");
    setTrackerTitle("Repayment cancelled");
    setTrackerMessage("You cancelled the repayment flow.");
    setTrackerGuidance("No payment was submitted. Update the amount and try again.");
    setIsSubmitting(false);
  };

  const handleRecoveryAction = (actionId: RecoveryActionId) => {
    switch (actionId) {
      case "retry_signing":
      case "resubmit": {
        // A repayment that reached the network is never resubmitted from here;
        // the plan only offers these when nothing was sent.
        setRecoveryPlan(null);
        setLastError(null);
        setTrackerState("idle");
        setTrackerTitle("Ready to repay");
        setTrackerMessage("");
        setIsSubmitting(false);
        break;
      }
      case "reconnect_wallet":
      case "reload_page":
        window.location.reload();
        break;
      case "contact_support":
        window.open(
          "https://github.com/JhayJ22/remitlend/issues/new",
          "_blank",
          "noopener,noreferrer",
        );
        break;
      case "copy_tx_hash":
      case "resume_tracking":
      case "check_explorer":
        // Handled inside the panel (clipboard / anchor / dashboard refresh).
        break;
    }
  };

  const handleRepayClick = async (event: FormEvent) => {
    event.preventDefault();
    if (!isWalletConnected || !walletAddress) {
      toast.error("Wallet not connected", "Please connect your wallet first.");
      return;
    }
    if (!amount || Number.isNaN(amountNumber) || amountNumber <= 0) {
      toast.error("Invalid amount", "Enter a repayment amount greater than zero.");
      return;
    }
    if (precisionError) {
      toast.error("Invalid precision", precisionError);
      return;
    }

    try {
      setIsSubmitting(true);

      const contractId = process.env.NEXT_PUBLIC_LOAN_MANAGER_CONTRACT_ID;
      if (!contractId) {
        throw new Error("Contract configuration missing");
      }

      const { buildUnsignedRepaymentXdr } = await import("../../../utils/soroban");
      const xdr = await buildUnsignedRepaymentXdr({
        borrower: walletAddress,
        loanId,
        amount: amountNumber,
        contractId,
      });

      txPreview.show(
        {
          operations: [
            {
              type: "Repay Loan",
              description: `Repaying ${amountNumber} for loan #${loanId}`,
              amount: amountNumber.toString(),
              token: "USDC", // Assuming USDC for now
            },
          ],
          balanceChanges: [
            {
              token: "USDC",
              change: `-${amountNumber}`,
              isPositive: false,
            },
          ],
          estimatedGasFee: "0.01",
          network: STELLAR_NETWORK_LABEL,
          contractAddress: contractId,
        },
        async () => {
          await executeRepayment(xdr);
        },
      );
    } catch (error) {
      const mapped = mapTransactionError(error);
      setLastError(mapped);
      setRecoveryPlan(planRecoveryFromDetails(mapped));
      toast.error(mapped.title, mapped.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const executeRepayment = async (unsignedXdr: string) => {
    let toastId: string | number | null = null;
    try {
      setTrackerState("signing");
      setTrackerTitle("Awaiting wallet confirmation");
      setTrackerMessage("Approve the repayment transaction in your wallet.");

      const signResult = await signTransaction(unsignedXdr, {
        networkPassphrase: STELLAR_NETWORK_PASSPHRASE,
      });
      if (signResult.error) {
        throw new Error(
          typeof signResult.error === "string" ? signResult.error : "Failed to sign transaction",
        );
      }

      setTrackerState("submitting");
      setTrackerTitle("Submitting repayment");
      setTrackerMessage("Sending repayment transaction to the network.");
      toastId = toast.showPending("Repayment transaction submitted");

      const result = await submitLoanTransaction(signResult.signedTxXdr);

      if (result.status === "SUCCESS") {
        setTrackerTxHash(result.txHash);
        setTrackerState("success");
        setTrackerTitle("Repayment recorded");
        setTrackerMessage("Your repayment was submitted and confirmed.");

        toast.showSuccess(toastId!, {
          successMessage: "Repayment confirmed",
          txHash: result.txHash,
        });

        // Invalidate cache (simulated by a short delay before refresh)
        setTimeout(() => {
          router.refresh();
        }, 2000);
      } else {
        throw new Error("Transaction failed");
      }
    } catch (error) {
      const mapped = mapTransactionError(error);
      const plan = planRecoveryFromDetails(mapped, {
        txHash: trackerTxHash,
        submitted: trackerTxHash !== null,
      });
      setLastError(mapped);
      setRecoveryPlan(plan);
      setTrackerState(mapped.cancelledByUser ? "cancelled" : "error");
      setTrackerTitle(plan.headline);
      setTrackerMessage(mapped.message);
      setTrackerGuidance(mapped.guidance);

      if (toastId) {
        toast.showError(toastId, {
          errorMessage: plan.headline,
        });
      } else {
        toast.error(plan.headline, mapped.message);
      }
    }
  };

  return (
    <section className="mx-auto max-w-3xl space-y-6">
      <header>
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-indigo-600">
          Borrower Portal
        </p>
        <h1 className="mt-3 text-3xl font-bold text-zinc-900 dark:text-zinc-50">
          Repay Loan #{loanId}
        </h1>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
          Real-time blockchain settlement for your loan repayments.
        </p>
      </header>

      <form
        onSubmit={handleRepayClick}
        className="space-y-4 rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm shadow-zinc-200/50 dark:border-zinc-800 dark:bg-zinc-950 dark:shadow-none"
      >
        <div>
          <label
            htmlFor="repayment-amount"
            className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
          >
            Repayment amount
          </label>
          <input
            id="repayment-amount"
            type="text"
            inputMode="decimal"
            step={Math.pow(10, -decimals)}
            value={amount}
            onChange={(event) => setAmount(sanitizeAmountInput(event.target.value))}
            onBlur={(event) => {
              const formatted = formatAmountOnBlur(event.target.value, "USDC");
              if (formatted && formatted !== event.target.value) {
                setAmount(formatted);
              }
            }}
            className={`mt-2 w-full rounded-2xl border bg-zinc-50 px-4 py-3 text-zinc-900 outline-none transition focus:border-indigo-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-50 ${
              precisionError ? "border-red-500" : "border-zinc-200"
            }`}
          />
          <p
            className={`mt-2 text-xs ${
              precisionError ? "text-red-600 dark:text-red-400" : "text-zinc-500 dark:text-zinc-400"
            }`}
          >
            {precisionError ?? helperText ?? `Up to ${decimals} decimal places supported.`}
          </p>
        </div>

        <Button
          type="submit"
          className="w-full"
          isLoading={isSubmitting}
          disabled={!!precisionError}
        >
          Review & Repay
        </Button>
      </form>

      <TransactionStatusTracker
        state={trackerState}
        title={trackerTitle}
        message={trackerMessage}
        guidance={trackerGuidance}
        txHash={trackerTxHash}
        onCancel={
          trackerState === "signing" || trackerState === "submitting" ? cancelFlow : undefined
        }
        disabled={isSubmitting}
      />

      {recoveryPlan && trackerState !== "success" && (
        <TransactionRecoveryPanel
          plan={recoveryPlan}
          txHash={trackerTxHash}
          onAction={handleRecoveryAction}
          busy={isSubmitting}
        />
      )}

      {txPreview.data && (
        <TransactionPreviewModal
          isOpen={txPreview.isOpen}
          onClose={txPreview.close}
          onConfirm={txPreview.confirm}
          data={txPreview.data}
          isLoading={txPreview.isLoading}
        />
      )}
    </section>
  );
}
