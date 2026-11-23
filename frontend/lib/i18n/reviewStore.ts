import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { FinancialStringManifest, ReviewState } from "./financialTranslations";

const API_URL = process.env.API_URL ?? "http://localhost:3001";
const MANIFEST_PATH = resolve(process.cwd(), "i18n/financial-strings.json");
const REVIEW_STATE_PATH = resolve(process.cwd(), "i18n/review-state.json");

export async function readJsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export function readManifest(): Promise<FinancialStringManifest> {
  return readJsonFile<FinancialStringManifest>(MANIFEST_PATH);
}

export function readReviewState(): Promise<ReviewState> {
  return readJsonFile<ReviewState>(REVIEW_STATE_PATH);
}

export async function writeReviewState(state: ReviewState): Promise<void> {
  const temporaryPath = `${REVIEW_STATE_PATH}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temporaryPath, REVIEW_STATE_PATH);
}

export type SessionCheck =
  { ok: true; role: string; publicKey: string } | { ok: false; status: number; error: string };

export async function verifyAdminSession(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SessionCheck> {
  let response: Response;
  try {
    response = await fetchImpl(`${API_URL}/auth/verify`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    return { ok: false, status: 500, error: "Session validation failed" };
  }

  if (response.status === 401) return { ok: false, status: 401, error: "Unauthorized" };
  if (!response.ok) return { ok: false, status: 502, error: "Session validation failed" };

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, status: 500, error: "Session validation failed" };
  }

  const body = payload as {
    data?: { role?: unknown; publicKey?: unknown };
    role?: unknown;
    publicKey?: unknown;
  };
  const session = body?.data ?? body;
  if (session?.role !== "admin") return { ok: false, status: 403, error: "Forbidden" };
  if (typeof session.publicKey !== "string" || session.publicKey.trim() === "") {
    return { ok: false, status: 400, error: "Reviewer identity unavailable" };
  }

  return { ok: true, role: "admin", publicKey: session.publicKey };
}
