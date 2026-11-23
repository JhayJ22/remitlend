import { NextRequest, NextResponse } from "next/server";
import {
  applyReviewDecision,
  type ReviewAction,
  type ReviewErrorCode,
} from "../../../../../lib/i18n/financialTranslations";
import {
  readManifest,
  readReviewState,
  verifyAdminSession,
  writeReviewState,
} from "../../../../../lib/i18n/reviewStore";

interface ReviewRequestBody {
  key?: string;
  locale?: string;
  action?: ReviewAction;
  expectedSourceHash?: string;
}

function statusFor(code: ReviewErrorCode): number {
  if (code === "unauthorized_reviewer") return 403;
  if (code === "stale_action") return 409;
  return 400;
}

export async function POST(request: NextRequest) {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const session = await verifyAdminSession(authorization.slice("Bearer ".length).trim());
  if (!session.ok) {
    return NextResponse.json({ error: session.error }, { status: session.status });
  }

  let body: ReviewRequestBody;
  try {
    body = (await request.json()) as ReviewRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid review body" }, { status: 400 });
  }

  if (
    typeof body.key !== "string" ||
    typeof body.locale !== "string" ||
    typeof body.action !== "string"
  ) {
    return NextResponse.json({ error: "key, locale, and action are required" }, { status: 400 });
  }

  try {
    const manifest = await readManifest();
    const state = await readReviewState();
    const result = applyReviewDecision({
      state,
      manifest,
      key: body.key,
      locale: body.locale,
      action: body.action,
      reviewer: session.publicKey,
      role: session.role,
      expectedSourceHash: body.expectedSourceHash,
    });

    if (!result.ok) {
      return NextResponse.json(
        { error: result.message, code: result.code },
        { status: statusFor(result.code) },
      );
    }

    if (result.changed) await writeReviewState(result.state);

    return NextResponse.json({
      approval: result.approval,
      changed: result.changed,
      reviewState: result.state,
    });
  } catch {
    return NextResponse.json({ error: "Review storage unavailable" }, { status: 500 });
  }
}
