"use client";

import { ShieldCheck } from "lucide-react";

export const STATEMENT_VERIFICATION_NOTICE =
  "Each CSV export includes a signed manifest.json. The manifest records the CSV SHA-256 digest, schema version, row count, source checkpoint, and signing key ID. No private signing material or wallet address is included.";

export const STATEMENT_VERIFICATION_ASSUMPTIONS = [
  "The signature proves the exact downloaded bytes were sealed by RemitLend and not modified afterwards; it does not re-verify the underlying API or Horizon snapshot.",
  "The source checkpoint identifies the projection snapshot used at export time. The Stellar ledger remains the ultimate authority for money and settlement.",
  "Amounts are exported exactly as returned by the source API; no currency conversion or rounding is applied by the signing service.",
];

export function StatementVerificationNotice() {
  return (
    <div
      data-testid="statement-verification-notice"
      className="rounded-lg border border-indigo-200 bg-indigo-50/60 p-3 text-xs text-indigo-900 dark:border-indigo-900/60 dark:bg-indigo-950/20 dark:text-indigo-200"
    >
      <div className="flex items-center gap-2 font-semibold">
        <ShieldCheck className="h-4 w-4" aria-hidden="true" />
        Verifiable statement export
      </div>
      <p className="mt-1" data-testid="statement-verification-summary">
        {STATEMENT_VERIFICATION_NOTICE}
      </p>
      <ul
        className="mt-2 list-disc space-y-1 pl-5"
        data-testid="statement-verification-assumptions"
      >
        {STATEMENT_VERIFICATION_ASSUMPTIONS.map((assumption) => (
          <li key={assumption}>{assumption}</li>
        ))}
      </ul>
    </div>
  );
}
