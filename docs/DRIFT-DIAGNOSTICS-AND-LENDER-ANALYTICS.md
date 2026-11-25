# Section-Aware Drift Diagnostics & Lender Financial Provenance

## 1. File, Section, and Command Drift Reporting
`scripts/report-doc-command-drift.mjs` tracks markdown headings while scanning `README.md` and `CONTRIBUTING.md`. When any command drifts from `package.json` configuration, the failure output identifies:
- **File**: e.g., `README.md` or `CONTRIBUTING.md`
- **Section**: The enclosing Markdown heading (`#section`)
- **Line & Command**: Exact line number and the command string that drifted.

## 2. Lender Yield Separation, Freshness Provenance & Accessible Analytics (`#545`, `#547`, `#548`, `#549`)
- **Yield Classification (`#545`)**: Lender views separate `realizedStroops`, `withdrawableStroops` (liquid pool reserves), and `projectedStroops` (unaccrued future interest).
- **Source Freshness & Degraded Provenance (`#547`)**: Financial surfaces display ledger/timestamp freshness and explicitly badge cached fallback states during RPC degradation.
- **Keyboard-Navigable Analytics (`#548`)**: Lender charts expose arrow-key datum traversal and a synchronized accessible data table.
- **Locale-Aware Asset Formatting (`#549`)**: Integer minor-unit formatting preserves precision across all supported locales (`en`, `es`, `tl`).

## 3. Settlement & Payout Exceptions Dashboard (`#829`)

The operational exceptions surface aggregates reconciliation discrepancies (delayed, duplicated,
mismatched, and unsettled settlement / payout items) by source and age.

### Backend API

`GET /api/v1/analytics/exceptions` (JWT + admin role required) returns:

- `totalOpen`, `totalCritical`, `totalResolved` counts over the requested window.
- `bySource`: exception buckets grouped by `discrepancy_class` (source) and age bucket
  (`0-24h`, `1-7d`, `8-30d`, `30d+`).
- `recent`: the 50 most recent exceptions with subject, source, severity, status, and detection
  time.

Implementation: `backend/src/services/analyticsService.ts` (`computeExceptionSummary`) and
`backend/src/routes/analyticsRoutes.ts`. No financial data is corrected; this is a read-only,
auditable view backed by `reconciliation_discrepancies`.

### Frontend

`frontend/src/components/SettlementExceptions.tsx` renders the exception summary cards, the
by-source/age table, and the recent-exceptions table, surfaced on the analytics dashboard. A
drill-down link points to `/admin/discrepancies`, where operators can acknowledge or resolve
individual exceptions (dual-control resolution via the privileged-actions flow).

### Supported states and behavior

- States: `open` / `resolved`; severities: `info` / `warning` / `critical`.
- Exceptions are recorded idempotently by `discrepancyLedgerService.recordDiscrepancy`; repeat
  scans bump `observation_count` without duplicating rows.
- Invalid or stale inputs are rejected (bad request / not found / conflict) with no partial
  financial side effects; resolution requires an actor, a reason (≥10 chars), and evidence.
- Access is admin-only; every resolution/acknowledgement is appended to `audit_logs`.
