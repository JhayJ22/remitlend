"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { localizeError, presentError, type ErrorPresentation } from "../../../lib/errors";

interface ActionableErrorProps {
  error?: unknown;
  presentation?: ErrorPresentation;
  onRetry?: () => void;
  onRefresh?: () => void;
  onReauthenticate?: () => void;
  onContactSupport?: () => void;
}

export function ActionableError({
  error,
  presentation: suppliedPresentation,
  onRetry,
  onRefresh,
  onReauthenticate,
  onContactSupport,
}: ActionableErrorProps) {
  const translate = useTranslations();
  const presentation = useMemo(
    () => suppliedPresentation ?? presentError(error),
    [suppliedPresentation, error],
  );
  const localized = useMemo(
    () => localizeError(presentation, translate),
    [presentation, translate],
  );

  const handler =
    presentation.action === "retry"
      ? onRetry
      : presentation.action === "refresh"
        ? (onRefresh ?? (() => window.location.reload()))
        : presentation.action === "reauthenticate"
          ? onReauthenticate
          : presentation.action === "contact_support"
            ? onContactSupport
            : undefined;

  return (
    <section
      role="alert"
      aria-live="assertive"
      className="rounded-2xl border border-red-200 bg-red-50 p-6 text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-100"
    >
      <h2 className="text-lg font-semibold">{localized.title}</h2>
      <p className="mt-2 text-sm">{localized.message}</p>
      <p className="mt-2 text-sm">{localized.guidance}</p>

      <div className="mt-4 flex flex-wrap items-center gap-3 text-xs">
        <span>
          {localized.referenceLabel}: <code className="font-mono">{presentation.code}</code>
        </span>
        {localized.referenceId && (
          <span>
            <code className="font-mono">{localized.referenceId}</code>
          </span>
        )}
      </div>

      {handler && (
        <button
          type="button"
          onClick={handler}
          className="mt-4 rounded-lg bg-red-700 px-4 py-2 text-sm font-medium text-white hover:bg-red-800"
        >
          {localized.actionLabel}
        </button>
      )}
    </section>
  );
}

export default ActionableError;
