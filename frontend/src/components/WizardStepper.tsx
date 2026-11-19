import React from 'react';

export interface WizardStep {
  id: string;
  title: string;
  description?: string;
}

export type WizardStepStatus = 'complete' | 'current' | 'upcoming';

export interface WizardStepperProps {
  steps: WizardStep[];
  /** Zero-based index of the active step. */
  currentStep: number;
  /** Optional explicit completion flags; defaults to index < currentStep. */
  completed?: boolean[];
  onStepClick?: (index: number) => void;
  className?: string;
}

function statusFor(
  index: number,
  currentStep: number,
  completed?: boolean[],
): WizardStepStatus {
  if (completed && completed[index]) return 'complete';
  if (index < currentStep) return 'complete';
  if (index === currentStep) return 'current';
  return 'upcoming';
}

const statusStyles: Record<WizardStepStatus, string> = {
  complete: 'bg-green-600 text-white border-green-600',
  current: 'bg-blue-600 text-white border-blue-600',
  upcoming: 'bg-white text-gray-500 border-gray-300',
};

const labelStyles: Record<WizardStepStatus, string> = {
  complete: 'text-green-700',
  current: 'text-blue-700 font-semibold',
  upcoming: 'text-gray-500',
};

/**
 * Horizontal progress indicator for multi-step flows (e.g. borrower onboarding).
 * Renders each step with a numbered/checked marker and a connecting line.
 */
export const WizardStepper: React.FC<WizardStepperProps> = ({
  steps,
  currentStep,
  completed,
  onStepClick,
  className = '',
}) => {
  return (
    <ol
      className={`flex w-full items-start ${className}`}
      aria-label="Progress"
    >
      {steps.map((step, index) => {
        const status = statusFor(index, currentStep, completed);
        const isLast = index === steps.length - 1;
        const clickable = Boolean(onStepClick) && status === 'complete';

        return (
          <li
            key={step.id}
            className="flex flex-1 items-start"
            aria-current={status === 'current' ? 'step' : undefined}
          >
            <div className="flex flex-col items-center text-center">
              <button
                type="button"
                disabled={!clickable}
                onClick={clickable ? () => onStepClick?.(index) : undefined}
                className={`flex h-9 w-9 items-center justify-center rounded-full border-2 text-sm font-medium transition-colors ${statusStyles[status]} ${
                  clickable ? 'cursor-pointer' : 'cursor-default'
                }`}
                aria-label={`Step ${index + 1}: ${step.title} (${status})`}
              >
                {status === 'complete' ? '\u2713' : index + 1}
              </button>
              <span className={`mt-2 max-w-[8rem] text-xs ${labelStyles[status]}`}>
                {step.title}
              </span>
              {step.description ? (
                <span className="mt-1 max-w-[8rem] text-[11px] text-gray-400">
                  {step.description}
                </span>
              ) : null}
            </div>
            {!isLast ? (
              <div
                className={`mx-2 mt-4 h-0.5 flex-1 ${
                  status === 'complete' ? 'bg-green-600' : 'bg-gray-300'
                }`}
                aria-hidden="true"
              />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
};

export default WizardStepper;
