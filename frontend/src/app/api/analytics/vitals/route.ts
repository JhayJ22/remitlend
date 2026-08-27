import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import { z } from "zod";

const vitalSchema = z.object({
  name: z.enum(["CLS", "INP", "LCP"]),
  value: z.number().finite().nonnegative(),
  rating: z.enum(["good", "needs-improvement", "poor"]),
  id: z.string().min(1).max(128),
  path: z.string().min(1).max(2048),
});

export async function POST(request: Request): Promise<NextResponse> {
  const result = vitalSchema.safeParse(await request.json().catch(() => null));
  if (!result.success) {
    return NextResponse.json({ error: "Invalid metric" }, { status: 400 });
  }

  Sentry.captureEvent({
    message: `Web Vital: ${result.data.name}`,
    level: result.data.rating === "poor" ? "warning" : "info",
    tags: { metric: result.data.name, rating: result.data.rating },
    extra: { value: result.data.value, id: result.data.id, path: result.data.path },
  });

  return NextResponse.json({ accepted: true }, { status: 202 });
}
