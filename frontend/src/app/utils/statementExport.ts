import { useUserStore } from "../stores/useUserStore";
import { downloadCsv } from "./csv";

export type StatementSourceType = "activity" | "wallet_payments" | "loan_events";

export interface SignedCsvExport {
  filename: string;
  csv: string;
  sourceType: StatementSourceType;
  sourceCheckpoint: string;
  rowCount: number;
}

export interface SignedStatementManifest {
  schema: string;
  manifestId: string;
  source: { type: StatementSourceType; checkpoint: string };
  statement: { sha256: string; rowCount: number; generatedAt: string };
  subjectHash: string;
  issuedAt: string;
  verification: {
    algorithm: string;
    keyId: string;
    instructions: string;
  };
  signature: string;
}

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function downloadTextFile(filename: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export async function downloadSignedCsv(
  exportInput: SignedCsvExport,
): Promise<SignedStatementManifest> {
  const token = useUserStore.getState().authToken;
  if (!token) {
    throw new Error("Sign in to export a verified statement.");
  }

  const statementDigest = await sha256Hex(exportInput.csv);
  const response = await fetch(`${API_URL}/api/v1/statements/manifests`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      sourceType: exportInput.sourceType,
      sourceCheckpoint: exportInput.sourceCheckpoint,
      statementDigest,
      rowCount: exportInput.rowCount,
      generatedAt: new Date().toISOString(),
    }),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? `Statement signing failed (${response.status}).`);
  }

  const payload = (await response.json()) as { success: boolean; data: SignedStatementManifest };
  downloadTextFile(
    `${exportInput.filename}.manifest.json`,
    JSON.stringify(payload.data, null, 2),
    "application/json",
  );
  downloadCsv(exportInput.filename, exportInput.csv);
  return payload.data;
}
