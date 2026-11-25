"use client";

import { ShieldCheck } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/Card";

export interface AbuseTelemetryNoticeProps {
  retentionDays?: number;
}

export const ABUSE_TELEMETRY_NOTICE_TEXT = {
  collected: "how often you start a financial action and whether it succeeded or was blocked",
  notCollected:
    "your wallet address, keys, signed transactions, IP address, transaction amounts, or any free-text you enter",
  access: "security administrators only",
};

export function AbuseTelemetryNotice({ retentionDays = 30 }: AbuseTelemetryNoticeProps) {
  return (
    <Card data-testid="abuse-telemetry-notice">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="h-4 w-4 text-indigo-500" aria-hidden="true" />
          Privacy-safe security checks
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm text-muted-foreground">
        <p data-testid="abuse-telemetry-notice-collected">
          To protect loans and transfers, we record {ABUSE_TELEMETRY_NOTICE_TEXT.collected}.
        </p>
        <p data-testid="abuse-telemetry-notice-exclusions">
          We never store {ABUSE_TELEMETRY_NOTICE_TEXT.notCollected}.
        </p>
        <p data-testid="abuse-telemetry-notice-retention">
          These coarse records are kept for {retentionDays} days and are visible to{" "}
          {ABUSE_TELEMETRY_NOTICE_TEXT.access}. They are used only for abuse detection and never
          determine your balance, loan terms, or credit score.
        </p>
      </CardContent>
    </Card>
  );
}

export default AbuseTelemetryNotice;
