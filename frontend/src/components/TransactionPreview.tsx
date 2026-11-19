import { useEffect, useMemo, useRef } from "react";

export type ScheduleStatus = "confirmed" | "stale" | "incomplete" | "mismatch" | "unavailable";

export interface AuthoritativeSchedule {
  scheduleVersion: string;
  policyVersion: string;
  asset: string;
  unit: string;
  rateBps: number;
  termMonths: number;
  principalMinor: number;
  feesMinor: number;
  totalDueMinor: number;
  status: ScheduleStatus;
}

export interface PreviewRequest {
  asset: string;
  unit: string;
  rateBps: number;
  termMonths: number;
  principalMinor: number;
  feesMinor: number;
  policyVersion: string;
}

export interface TransactionPreviewProps {
  request: PreviewRequest;
  schedule?: AuthoritativeSchedule | null;
  onRetry?: () => void;
  onSign?: () => void;
}

function formatMinor(minor: number, unit: string): string {
  const whole = Math.trunc(minor / 100);
  const frac = Math.abs(minor % 100).toString().padStart(2, "0");
  return `${whole}.${frac} ${unit}`;
}

export function reconcileSchedule(
  request: PreviewRequest,
  schedule?: AuthoritativeSchedule | null,
): { ok: boolean; reason?: string } {
  if (!schedule) return { ok: false, reason: "Authoritative schedule unavailable" };
  if (schedule.status === "stale") return { ok: false, reason: "Schedule is stale" };
  if (schedule.status === "incomplete") return { ok: false, reason: "Schedule is incomplete" };
  if (schedule.status === "unavailable") return { ok: false, reason: "Schedule unavailable" };
  if (schedule.status === "mismatch") return { ok: false, reason: "Schedule inconsistent with request" };
  if (schedule.policyVersion !== request.policyVersion)
    return { ok: false, reason: "Policy version mismatch" };
  if (
    schedule.asset !== request.asset ||
    schedule.unit !== request.unit ||
    schedule.rateBps !== request.rateBps ||
    schedule.termMonths !== request.termMonths ||
    schedule.principalMinor !== request.principalMinor ||
    schedule.feesMinor !== request.feesMinor
  )
    return { ok: false, reason: "Terms changed since preview" };
  if (schedule.principalMinor + schedule.feesMinor !== schedule.totalDueMinor)
    return { ok: false, reason: "Totals do not reconcile" };
  return { ok: true };
}

interface ChangedField {
  label: string;
  estimate: string;
  confirmed: string;
}

function collectChangedFields(
  request: PreviewRequest,
  schedule?: AuthoritativeSchedule | null,
): ChangedField[] {
  if (!schedule) return [];
  const changed: ChangedField[] = [];
  if (schedule.asset !== request.asset || schedule.unit !== request.unit) {
    changed.push({
      label: "Asset / unit",
      estimate: `${request.asset} / ${request.unit}`,
      confirmed: `${schedule.asset} / ${schedule.unit}`,
    });
  }
  if (schedule.rateBps !== request.rateBps) {
    changed.push({
      label: "Rate",
      estimate: `${(request.rateBps / 100).toFixed(2)}%`,
      confirmed: `${(schedule.rateBps / 100).toFixed(2)}%`,
    });
  }
  if (schedule.termMonths !== request.termMonths) {
    changed.push({
      label: "Term",
      estimate: `${request.termMonths} months`,
      confirmed: `${schedule.termMonths} months`,
    });
  }
  if (schedule.principalMinor !== request.principalMinor) {
    changed.push({
      label: "Principal",
      estimate: formatMinor(request.principalMinor, request.unit),
      confirmed: formatMinor(schedule.principalMinor, schedule.unit),
    });
  }
  if (schedule.feesMinor !== request.feesMinor) {
    changed.push({
      label: "Fees",
      estimate: formatMinor(request.feesMinor, request.unit),
      confirmed: formatMinor(schedule.feesMinor, schedule.unit),
    });
  }
  return changed;
}

export default function TransactionPreview({
  request,
  schedule,
  onRetry,
  onSign,
}: TransactionPreviewProps) {
  const check = useMemo(() => reconcileSchedule(request, schedule), [request, schedule]);
  const canSign = check.ok;
  const changedFields = useMemo(
    () => collectChangedFields(request, schedule),
    [request, schedule],
  );

  const errorRef = useRef<HTMLParagraphElement | null>(null);
  const signRef = useRef<HTMLButtonElement | null>(null);
  const retryRef = useRef<HTMLButtonElement | null>(null);
  const wasBlocked = useRef(false);

  // Move focus to the error when signing becomes blocked, and return focus to
  // the sign button once the schedule reconciles again. Never trap focus.
  useEffect(() => {
    if (!canSign) {
      wasBlocked.current = true;
      errorRef.current?.focus();
    } else if (wasBlocked.current) {
      wasBlocked.current = false;
      signRef.current?.focus();
    }
  }, [canSign]);

  const stateLabel = !schedule
    ? "loading"
    : canSign
      ? changedFields.length > 0
        ? "ready with changed fields"
        : "ready"
      : "error";

  return (
    <section className="transaction-preview" aria-labelledby="preview-heading">
      <h3 id="preview-heading">Loan cost preview</h3>
      <p className="preview-state" aria-live="polite">
        Preview state: {stateLabel}
      </p>
      <dl>
        <dt>Schedule version</dt>
        <dd>{schedule?.scheduleVersion ?? "—"}</dd>
        <dt>Policy version</dt>
        <dd>{schedule?.policyVersion ?? request.policyVersion}</dd>
        <dt>Asset / unit</dt>
        <dd>{request.asset} / {request.unit}</dd>
        <dt>Rate</dt>
        <dd>{(request.rateBps / 100).toFixed(2)}%</dd>
        <dt>Term</dt>
        <dd>{request.termMonths} months</dd>
        <dt>Principal (estimate)</dt>
        <dd>{formatMinor(request.principalMinor, request.unit)}</dd>
        <dt>Principal (confirmed)</dt>
        <dd>{schedule ? formatMinor(schedule.principalMinor, schedule.unit) : "—"}</dd>
        <dt>Fees (estimate)</dt>
        <dd>{formatMinor(request.feesMinor, request.unit)}</dd>
        <dt>Fees (confirmed)</dt>
        <dd>{schedule ? formatMinor(schedule.feesMinor, schedule.unit) : "—"}</dd>
        <dt>Total due (confirmed)</dt>
        <dd>{schedule ? formatMinor(schedule.totalDueMinor, schedule.unit) : "—"}</dd>
      </dl>
      <div className="preview-changed" aria-live="polite" aria-atomic="true">
        <h4>Changed fields</h4>
        {changedFields.length === 0 ? (
          <p>No fields changed since preview.</p>
        ) : (
          <ul>
            {changedFields.map((field) => (
              <li key={field.label}>
                {field.label}: estimate {field.estimate}, confirmed {field.confirmed}
              </li>
            ))}
          </ul>
        )}
      </div>
      {!canSign && (
        <p className="preview-error" role="alert" tabIndex={-1} ref={errorRef}>
          {check.reason}. Signing is blocked until the schedule is refreshed.
        </p>
      )}
      <div className="preview-actions">
        <button type="button" onClick={onRetry} disabled={!onRetry} ref={retryRef}>
          Retry schedule
        </button>
        <button
          type="button"
          onClick={onSign}
          disabled={!canSign || !onSign}
          aria-describedby={!canSign ? "preview-error" : undefined}
          ref={signRef}
        >
          Sign transaction
        </button>
      </div>
    </section>
  );
}
