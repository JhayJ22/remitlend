import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import LoanCostDisclosurePanel from './LoanCostDisclosurePanel';

// Version of the risk disclosure content rendered below. Bump this whenever the
// disclosure text changes so acknowledgments are recorded against the version
// the borrower actually saw. Existing loans keep their recorded version.
export const RISK_DISCLOSURE_VERSION = '1.0.0';

const RISK_DISCLOSURE_SECTIONS: { heading: string; body: string[] }[] = [
  {
    heading: '1. Nature of the Loan',
    body: [
      'This loan is issued on-chain and secured by collateral you provide. Borrowing carries risk, including the risk of losing your collateral if you fail to repay.',
      'The terms shown in this wizard are final once you sign. Review the repayment schedule and total cost before proceeding.',
    ],
  },
  {
    heading: '2. Liquidation Risk',
    body: [
      'If the value of your collateral falls below the required threshold, your collateral may be liquidated automatically to repay the outstanding balance.',
      'Liquidation may occur without prior notice and may result in the loss of some or all of your collateral.',
    ],
  },
  {
    heading: '3. Interest and Fees',
    body: [
      'Interest accrues according to the schedule disclosed in the repayment step. Additional fees, including origination and network fees, are disclosed in the loan cost breakdown.',
      'Total cost of credit may exceed the principal amount borrowed.',
    ],
  },
  {
    heading: '4. No Investment Advice',
    body: [
      'Nothing in this application constitutes financial, legal, or tax advice. You are responsible for ensuring this loan is suitable for your circumstances.',
    ],
  },
  {
    heading: '5. Acknowledgment',
    body: [
      'By scrolling to the end of this disclosure and signing, you acknowledge that you have read and understood the risks described above.',
    ],
  },
];

export interface LoanApplicationWizardProps {
  onComplete?: (payload: { disclosureVersion: string }) => void;
}

type WizardStep = 'details' | 'repayment' | 'signature';

const STEPS: { id: WizardStep; label: string }[] = [
  { id: 'details', label: 'Loan Details' },
  { id: 'repayment', label: 'Repayment Schedule' },
  { id: 'signature', label: 'Confirm & Sign' },
];

interface StepRepaymentScheduleProps {
  principal: number;
  interestRate: number;
  termMonths: number;
}

const StepRepaymentSchedule: React.FC<StepRepaymentScheduleProps> = ({
  principal,
  interestRate,
  termMonths,
}) => {
  return (
    <div className="loan-wizard__step loan-wizard__step--repayment">
      <h2>Repayment Schedule</h2>
      <p>
        Review the full cost breakdown below before continuing to the signature step.
      </p>
      <LoanCostDisclosurePanel
        principal={principal}
        interestRate={interestRate}
        termMonths={termMonths}
      />
    </div>
  );
};

interface StepFinalSignatureProps {
  disclosureVersion: string;
  onAcknowledgedChange: (acknowledged: boolean) => void;
}

const StepFinalSignature: React.FC<StepFinalSignatureProps> = ({
  disclosureVersion,
  onAcknowledgedChange,
}) => {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrolledToEnd, setScrolledToEnd] = useState(false);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
    if (atBottom && !scrolledToEnd) {
      setScrolledToEnd(true);
      onAcknowledgedChange(true);
    }
  }, [onAcknowledgedChange, scrolledToEnd]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // If the disclosure fits without scrolling, treat it as fully read.
    if (el.scrollHeight <= el.clientHeight + 8 && !scrolledToEnd) {
      setScrolledToEnd(true);
      onAcknowledgedChange(true);
    }
  }, [onAcknowledgedChange, scrolledToEnd]);

  return (
    <div className="loan-wizard__step loan-wizard__step--signature">
      <h2>Risk Disclosure</h2>
      <p className="loan-wizard__disclosure-version">
        Disclosure version: {disclosureVersion}
      </p>
      <div
        ref={scrollRef}
        className="loan-wizard__risk-disclosure"
        onScroll={handleScroll}
        data-testid="risk-disclosure"
        tabIndex={0}
        style={{ maxHeight: 320, overflowY: 'auto' }}
      >
        {RISK_DISCLOSURE_SECTIONS.map((section) => (
          <section key={section.heading}>
            <h3>{section.heading}</h3>
            {section.body.map((paragraph, idx) => (
              <p key={idx}>{paragraph}</p>
            ))}
          </section>
        ))}
      </div>
      {!scrolledToEnd && (
        <p className="loan-wizard__scroll-hint" role="status">
          Scroll to the bottom of the disclosure to enable signing.
        </p>
      )}
    </div>
  );
};

const LoanApplicationWizard: React.FC<LoanApplicationWizardProps> = ({ onComplete }) => {
  const [stepIndex, setStepIndex] = useState(0);
  const [disclosureAcknowledged, setDisclosureAcknowledged] = useState(false);

  const principal = 10000;
  const interestRate = 0.12;
  const termMonths = 24;

  const currentStep = STEPS[stepIndex];

  const canProceed = useMemo(() => {
    if (currentStep.id === 'signature') {
      return disclosureAcknowledged;
    }
    return true;
  }, [currentStep.id, disclosureAcknowledged]);

  const handleNext = useCallback(() => {
    if (stepIndex < STEPS.length - 1) {
      setStepIndex((i) => i + 1);
      return;
    }
    onComplete?.({ disclosureVersion: RISK_DISCLOSURE_VERSION });
  }, [onComplete, stepIndex]);

  const handleBack = useCallback(() => {
    setStepIndex((i) => Math.max(0, i - 1));
  }, []);

  return (
    <div className="loan-wizard">
      <ol className="loan-wizard__steps">
        {STEPS.map((step, idx) => (
          <li
            key={step.id}
            className={idx === stepIndex ? 'loan-wizard__step-item--active' : undefined}
          >
            {step.label}
          </li>
        ))}
      </ol>

      {currentStep.id === 'details' && (
        <div className="loan-wizard__step loan-wizard__step--details">
          <h2>Loan Details</h2>
          <p>Principal: {principal}</p>
          <p>Interest rate: {(interestRate * 100).toFixed(2)}%</p>
          <p>Term: {termMonths} months</p>
        </div>
      )}

      {currentStep.id === 'repayment' && (
        <StepRepaymentSchedule
          principal={principal}
          interestRate={interestRate}
          termMonths={termMonths}
        />
      )}

      {currentStep.id === 'signature' && (
        <StepFinalSignature
          disclosureVersion={RISK_DISCLOSURE_VERSION}
          onAcknowledgedChange={setDisclosureAcknowledged}
        />
      )}

      <div className="loan-wizard__actions">
        <button type="button" onClick={handleBack} disabled={stepIndex === 0}>
          Back
        </button>
        <button
          type="button"
          onClick={handleNext}
          disabled={!canProceed}
          data-testid="confirm-and-sign"
        >
          {currentStep.id === 'signature' ? 'Confirm and Sign' : 'Next'}
        </button>
      </div>
    </div>
  );
};

export default LoanApplicationWizard;
