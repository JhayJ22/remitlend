"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PenLine, CircleAlert, CheckCircle2, Loader2 } from "lucide-react";
import { Button } from "../ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/Card";
import { TransactionPreviewModal } from "../transaction/TransactionPreviewModal";
import { TransactionRecoveryPanel } from "../transaction/TransactionRecoveryPanel";
import { LoanCostDisclosureError, LoanCostDisclosurePanel } from "../loan/LoanCostDisclosurePanel";
import {
  TransactionStatusTracker,
  type TransactionStatusState,
} from "../ui/TransactionStatusTracker";
import { useTransactionPreview } from "../../hooks/useTransactionPreview";
import { useCreateLoan, useLoanAmortizationPreview } from "../../hooks/useApi";
import { useContractToast } from "../../hooks/useContractToast";
import { buildUnsignedLoanRequestXdr } from "../../utils/soroban";
import {
  mapTransactionError,
  pollTransactionStatus,
  type TransactionErrorDetails,
} from "../../utils/transactionErrors";
import {
  planRecoveryFromDetails,
  type RecoveryActionId,
  type TransactionRecoveryPlan,
} from "../../utils/transactionRecovery";
import {
  applyAuthoritativeTotals,
  computeLoanCostDisclosure,
  DEFAULT_LOAN_ANNUAL_RATE_BPS,
  formatBps,
  reconcileWithAmortization,
  type LoanCostDisclosure,
} from "../../utils/loanCostDisclosure";
import type { LoanWizardData } from "./LoanApplicationWizard";

const SUPPORT_URL = "https://github.com/JhayJ22/remitlend/issues/new";

function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

interface StepFinalSignatureProps {
  data: LoanWizardData;
  borrowerAddress: string;
  onBack: () => void;
  onSuccess: (loanId: string) => void;
}

export function StepFinalSignature({
  data,
  borrowerAddress,
  onBack,
  onSuccess,
}: StepFinalSignatureProps) {
  const [unsignedXdr, setUnsignedXdr] = useState<string>("");
  const [xdrError, setXdrError] = useState<string | null>(null);
  const [isBuildingXdr, setIsBuildingXdr] = useState(false);
  const [trackerState, setTrackerState] = useState<TransactionStatusState>("idle");
  const [trackerTitle, setTrackerTitle] = useState("Ready to submit");
  const [trackerMessage, setTrackerMessage] = useState("");
  const [trackerGuidance, setTrackerGuidance] = useState<string | undefined>(undefined);
  const [trackerTxHash, setTrackerTxHash] = useState<string | null>(null);
  const [lastErrorDetails, setLastErrorDetails] = useState<TransactionErrorDetails | null>(null);
  const [recoveryPlan, setRecoveryPlan] = useState<TransactionRecoveryPlan | null>(null);

  const pollingAbortControllerRef = useRef<AbortController | null>(null);
  /**
   * Hash of the transaction currently being tracked. Retained separately from
   * the tracker state so a recovery action can resume tracking the *same*
   * transaction instead of submitting a duplicate one.
   */
  const submittedTxHashRef = useRef<string | null>(null);
  /** Loan id returned alongside the submitted hash, used when tracking resumes. */
  const submittedLoanIdRef = useRef<string>("");

  const txPreview = useTransactionPreview();
  const createLoan = useCreateLoan();
  const toast = useContractToast();

  const principal = Number(data.amount || "0");
  const termDays = data.termDays;

  // The lending pool schedule is the settlement source of record. It is
  // already cached from the repayment step, so this is normally a cache hit;
  // when it is unavailable the disclosure falls back to the local estimate and
  // says so.
  const amortizationQuery = useLoanAmortizationPreview(
    principal > 0 ? { amount: principal, termDays } : undefined,
    { retry: false },
  );

  const cost = useMemo(() => {
    const result = computeLoanCostDisclosure({
      principal: data.amount,
      asset: data.asset,
      termDays,
      annualRateBps: Number(DEFAULT_LOAN_ANNUAL_RATE_BPS),
      lateFeeBps: 50,
      networkFee: { amount: "0.00001", asset: "XLM" },
    });
    if (!result.ok) return result;
    return {
      ok: true as const,
      disclosure: applyAuthoritativeTotals(result.disclosure, amortizationQuery.data),
    };
  }, [data.amount, data.asset, termDays, amortizationQuery.data]);

  const reconciliation = useMemo(
    () =>
      cost.ok ? reconcileWithAmortization(cost.disclosure, amortizationQuery.data) : undefined,
    [cost, amortizationQuery.data],
  );

  const disclosure: LoanCostDisclosure | null = cost.ok ? cost.disclosure : null;
  const dueDate = disclosure ? new Date(`${disclosure.dueDate}T00:00:00Z`) : new Date();

  // Pre-build the XDR so the user can see it in the summary.
  // All setState calls happen inside an async IIFE to satisfy react-hooks/set-state-in-effect.
  useEffect(() => {
    if (!borrowerAddress || principal <= 0) return;

    let cancelled = false;

    void (async () => {
      const managerContractId =
        process.env.NEXT_PUBLIC_LENDING_POOL_CONTRACT_ID ??
        // Deprecated alias, kept for backward compatibility.
        process.env.NEXT_PUBLIC_MANAGER_CONTRACT_ID;
      if (!managerContractId) {
        if (!cancelled) setXdrError("Missing NEXT_PUBLIC_LENDING_POOL_CONTRACT_ID configuration.");
        return;
      }

      if (!cancelled) {
        setIsBuildingXdr(true);
        setXdrError(null);
      }

      try {
        const xdr = await buildUnsignedLoanRequestXdr({
          borrower: borrowerAddress,
          amount: principal,
          term: data.termDays * 17280,
          contractId: managerContractId,
        });
        if (!cancelled) setUnsignedXdr(xdr);
      } catch (err) {
        if (!cancelled)
          setXdrError(err instanceof Error ? err.message : "Failed to build unsigned XDR.");
      } finally {
        if (!cancelled) setIsBuildingXdr(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [borrowerAddress, principal]);

  useEffect(() => {
    return () => {
      pollingAbortControllerRef.current?.abort();
      pollingAbortControllerRef.current = null;
    };
  }, []);

  const resetTracker = useCallback(() => {
    setTrackerState("idle");
    setTrackerTitle("Ready to submit");
    setTrackerMessage("");
    setTrackerGuidance(undefined);
    setTrackerTxHash(null);
    setLastErrorDetails(null);
    setRecoveryPlan(null);
  }, []);

  const cancelTracking = () => {
    pollingAbortControllerRef.current?.abort();
    pollingAbortControllerRef.current = null;
    setTrackerState("cancelled");
    setTrackerTitle("Status tracking cancelled");
    setTrackerMessage("You cancelled this transaction flow.");
    setTrackerGuidance("If needed, you can retry submission.");
  };

  /** Track an already-submitted transaction. Never submits anything new. */
  const trackSubmittedTransaction = useCallback(
    async (txHash: string, loanId: string, toastId: string | number | null) => {
      setTrackerTxHash(txHash);
      setTrackerState("polling");
      setTrackerTitle("Waiting for on-chain confirmation");
      setTrackerMessage("Tracking transaction status on Stellar testnet.");
      setRecoveryPlan(null);

      const controller = new AbortController();
      pollingAbortControllerRef.current = controller;

      const pollResult = await pollTransactionStatus(txHash, { signal: controller.signal });
      pollingAbortControllerRef.current = null;

      if (pollResult.status === "success") {
        setTrackerState("success");
        setTrackerTitle("Transaction confirmed");
        setTrackerMessage("Your loan request is confirmed on-chain.");
        setTrackerGuidance("You can monitor approval status from your loans dashboard.");
        if (toastId !== null) {
          toast.showSuccess(toastId, {
            successMessage: "Loan request confirmed on-chain",
            txHash,
          });
        }
        onSuccess(loanId);
        return;
      }

      if (pollResult.status === "cancelled") {
        setTrackerState("cancelled");
        setTrackerTitle("Status tracking cancelled");
        setTrackerMessage(pollResult.message);
        setTrackerGuidance("You can resume tracking or inspect the transaction.");
        return;
      }

      // A submitted transaction that has not confirmed is a *tracking* failure,
      // not a submission failure. Surface a recovery plan that leads with
      // "check the status again" so the borrower never resubmits a loan that
      // may already exist on chain.
      const pollError = mapTransactionError(
        pollResult.dependencyFailure
          ? "Unable to reach the network to confirm this transaction"
          : pollResult.status === "failed"
            ? "Transaction failed on-chain"
            : "Network timeout while polling status",
      );

      const plan = planRecoveryFromDetails(pollError, { txHash, submitted: true });
      setRecoveryPlan(plan);
      setLastErrorDetails(pollError);
      setTrackerState("error");
      setTrackerTitle(plan.headline);
      setTrackerMessage(pollResult.message);
      setTrackerGuidance(pollError.guidance);

      if (toastId !== null) {
        toast.showError(toastId, {
          errorMessage: plan.headline,
          retryAction: () => void trackSubmittedTransaction(txHash, loanId, toastId),
        });
      } else {
        toast.error(plan.headline, pollResult.message);
      }
    },
    [onSuccess, toast],
  );

  /** Resume tracking the previously submitted transaction (no new signature). */
  const resumeTracking = useCallback(() => {
    const hash = submittedTxHashRef.current;
    if (!hash) return;
    void (async () => {
      try {
        await trackSubmittedTransaction(hash, submittedLoanIdRef.current, null);
      } catch {
        // trackSubmittedTransaction already renders a recovery plan.
      }
    })();
  }, [trackSubmittedTransaction]);

  const handleSignAndSubmit = () => {
    const managerContractId =
      process.env.NEXT_PUBLIC_LENDING_POOL_CONTRACT_ID ??
      // Deprecated alias, kept for backward compatibility.
      process.env.NEXT_PUBLIC_MANAGER_CONTRACT_ID;
    if (!managerContractId) {
      setXdrError("Missing NEXT_PUBLIC_LENDING_POOL_CONTRACT_ID configuration.");
      return;
    }
    if (!disclosure) {
      // Never let the borrower sign a request whose cost cannot be disclosed.
      return;
    }

    resetTracker();

    txPreview.show(
      {
        operations: [
          {
            type: "request_loan",
            description: `Request ${data.amount} ${data.asset} for ${termDays} days`,
            amount: data.amount,
            token: data.asset,
            details: {
              "Credit Score": data.creditScore,
              "Amount Received": `${disclosure.amountFinanced} ${data.asset}`,
              "Interest Rate (nominal APR)": formatBps(disclosure.annualRateBps),
              "Effective APR (all fees)": formatBps(disclosure.effectiveAprBps),
              "Interest over term": `${disclosure.interest} ${data.asset}`,
              "Upfront fees": `${disclosure.upfrontFees} ${data.asset}`,
              "Total Cost of Credit": `${disclosure.totalCostOfCredit} ${data.asset}`,
              "Total Repayment": `${disclosure.totalRepayment} ${data.asset}`,
              "Estimated Due Date": dueDate.toLocaleDateString(),
              Term: `${termDays} days`,
              ...(unsignedXdr && {
                "Unsigned XDR": `${unsignedXdr.slice(0, 16)}...${unsignedXdr.slice(-16)}`,
              }),
            },
          },
        ],
        balanceChanges: [
          { token: data.asset, change: disclosure.amountFinanced, isPositive: true },
        ],
        estimatedGasFee: "0.00001",
        network: "Stellar Testnet",
        contractAddress: managerContractId,
      },
      async () => {
        let toastId: string | number | null = null;

        setTrackerState("signing");
        setTrackerTitle("Waiting for wallet signature");
        setTrackerMessage("Approve the transaction in your wallet to continue.");

        try {
          setTrackerState("submitting");
          setTrackerTitle("Submitting transaction");
          setTrackerMessage("Sending your loan request to the network.");
          toastId = toast.showPending("Transaction submitted");

          const loan = await createLoan.mutateAsync({
            amount: principal,
            currency: data.asset,
            interestRate: Number(DEFAULT_LOAN_ANNUAL_RATE_BPS) / 100,
            termDays: termDays,
            borrowerId: borrowerAddress,
          });

          if (!loan.txHash) {
            submittedTxHashRef.current = null;
            submittedLoanIdRef.current = "";
            setTrackerState("success");
            setTrackerTitle("Loan request submitted");
            setTrackerMessage("Your request was accepted and recorded.");
            setTrackerGuidance("You can monitor approval status from your loans dashboard.");
            if (toastId !== null) {
              toast.showSuccess(toastId, {
                successMessage: "Loan request submitted successfully",
              });
            } else {
              toast.success("Loan request submitted successfully");
            }
            onSuccess(loan.id);
            return;
          }

          submittedTxHashRef.current = loan.txHash;
          submittedLoanIdRef.current = loan.id;
          await trackSubmittedTransaction(loan.txHash, loan.id, toastId);
        } catch (error) {
          const mapped = mapTransactionError(error);
          const plan = planRecoveryFromDetails(mapped, {
            txHash: submittedTxHashRef.current,
            submitted: submittedTxHashRef.current !== null,
          });
          setLastErrorDetails(mapped);
          setRecoveryPlan(plan);

          setTrackerState(mapped.cancelledByUser ? "cancelled" : "error");
          setTrackerTitle(plan.headline);
          setTrackerMessage(mapped.message);
          setTrackerGuidance(mapped.guidance);

          if (toastId !== null) {
            // Never offer a toast-level resubmit once a hash exists; that
            // would create a second on-chain loan request.
            toast.showError(toastId, {
              errorMessage: plan.headline,
              retryAction:
                mapped.retryable && submittedTxHashRef.current === null
                  ? retrySubmission
                  : undefined,
            });
          } else {
            toast.error(plan.headline, mapped.message);
          }

          throw error;
        }
      },
    );
  };

  const retrySubmission = () => {
    txPreview.close();
    if (submittedTxHashRef.current !== null) {
      // Hard guard against a duplicate loan: a transaction may already be on
      // chain, so re-check its status instead of building a new one.
      resumeTracking();
      return;
    }
    handleSignAndSubmit();
  };

  const handleRecoveryAction = useCallback(
    (actionId: RecoveryActionId) => {
      switch (actionId) {
        case "resume_tracking":
          resumeTracking();
          break;
        case "retry_signing":
        case "resubmit":
          retrySubmission();
          break;
        case "reconnect_wallet":
        case "reload_page":
          if (typeof window !== "undefined") window.location.reload();
          break;
        case "contact_support":
          if (typeof window !== "undefined") {
            window.open(SUPPORT_URL, "_blank", "noopener,noreferrer");
          }
          break;
        case "copy_tx_hash":
        case "check_explorer":
          // Handled inside the panel (clipboard / anchor).
          break;
      }
    },
    [resumeTracking],
  );

  /**
   * The inline tracker's Retry is only safe when nothing ever reached the
   * network. Once a hash exists the borrower must go through the recovery
   * panel, which offers status checks instead of a new submission.
   */
  const hasSubmittedTransaction = submittedTxHashRef.current !== null;
  const canRetryInline =
    !hasSubmittedTransaction &&
    (trackerState === "error" || trackerState === "cancelled") &&
    lastErrorDetails?.retryable !== false;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <PenLine className="h-5 w-5 text-indigo-500" />
            Final Signature
          </CardTitle>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Review the full loan summary, then sign and submit your application.
          </p>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Cost of loan disclosure — the binding summary for this step. */}
          {cost.ok && disclosure ? (
            <LoanCostDisclosurePanel
              disclosure={disclosure}
              reconciliation={reconciliation}
              title="Cost of Loan Disclosure"
              description="What this loan costs you in total, before you sign anything."
            />
          ) : (
            !cost.ok && <LoanCostDisclosureError error={cost.error} />
          )}

          {/* XDR preview */}
          <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
            <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
              Unsigned Soroban XDR
            </p>
            {isBuildingXdr && (
              <div
                role="status"
                className="mt-2 flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400"
              >
                <Loader2 className="h-4 w-4 animate-spin" />
                Building transaction...
              </div>
            )}
            {xdrError && (
              <div className="mt-2 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300">
                <CircleAlert className="mt-0.5 h-3 w-3 shrink-0" />
                {xdrError} (XDR preview unavailable — you may still proceed)
              </div>
            )}
            {unsignedXdr && !isBuildingXdr && (
              <p className="mt-2 break-all font-mono text-xs text-zinc-600 dark:text-zinc-400">
                {unsignedXdr}
              </p>
            )}
          </div>

          <TransactionStatusTracker
            state={trackerState}
            title={trackerTitle}
            message={trackerMessage}
            guidance={trackerGuidance}
            txHash={trackerTxHash}
            onCancel={
              trackerState === "signing" ||
              trackerState === "submitting" ||
              trackerState === "polling"
                ? cancelTracking
                : undefined
            }
            onRetry={canRetryInline ? retrySubmission : undefined}
            disabled={createLoan.isPending || txPreview.isLoading}
          />

          {/* Recovery UX for rejected, expired and stalled transactions. */}
          {recoveryPlan && trackerState !== "success" && (
            <TransactionRecoveryPanel
              plan={recoveryPlan}
              txHash={trackerTxHash ?? submittedTxHashRef.current}
              onAction={handleRecoveryAction}
              busy={createLoan.isPending}
            />
          )}

          <div className="flex gap-3">
            <Button variant="outline" onClick={onBack} className="w-full">
              Back
            </Button>
            <Button
              onClick={handleSignAndSubmit}
              isLoading={createLoan.isPending}
              disabled={isBuildingXdr || !disclosure}
              className="w-full"
              leftIcon={<CheckCircle2 className="h-4 w-4" />}
            >
              Sign &amp; Submit
            </Button>
          </div>

          {disclosure && (
            <p className="text-center text-xs text-zinc-500 dark:text-zinc-400">
              First payment due {formatDate(dueDate)}.
            </p>
          )}
        </CardContent>
      </Card>

      {txPreview.data && (
        <TransactionPreviewModal
          isOpen={txPreview.isOpen}
          onClose={txPreview.close}
          onConfirm={txPreview.confirm}
          data={txPreview.data}
          isLoading={txPreview.isLoading || createLoan.isPending}
        />
      )}
    </div>
  );
}
