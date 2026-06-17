import { NextRequest, NextResponse } from "next/server";
import { defaultLimiter } from "@trihards/core";
import { isAuthFailure, requireAuth } from "@/lib/auth";
import { withLimit } from "@/lib/api";
import {
  clearOverride,
  getOverrides,
  setOverride,
  validateOverrideInput,
} from "@/lib/plan-overrides";

async function gate() {
  const auth = await requireAuth();
  if (isAuthFailure(auth)) return { error: auth as NextResponse };
  const limited = await withLimit(defaultLimiter(), auth.userId);
  if (limited) return { error: limited };
  return { userId: auth.userId };
}

export async function GET() {
  const g = await gate();
  if (g.error) return g.error;
  return NextResponse.json(await getOverrides(g.userId));
}

export async function POST(request: NextRequest) {
  const g = await gate();
  if (g.error) return g.error;
  try {
    const input = validateOverrideInput(await request.json());
    const result = await setOverride(g.userId, input);
    return NextResponse.json(result ?? { cleared: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid input" },
      { status: 400 },
    );
  }
}

export async function DELETE(request: NextRequest) {
  const g = await gate();
  if (g.error) return g.error;
  const id = new URL(request.url).searchParams.get("sessionId");
  if (!id) return NextResponse.json({ error: "sessionId required" }, { status: 400 });
  return (await clearOverride(g.userId, id))
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: "Not found" }, { status: 404 });
}
