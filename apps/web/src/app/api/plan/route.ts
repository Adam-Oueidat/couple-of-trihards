import { NextRequest, NextResponse } from "next/server";
import { defaultLimiter } from "@trihards/core";
import { isAuthFailure, requireAuth } from "@/lib/auth";
import { withLimit } from "@/lib/api";
import {
  deleteTrainingPlan,
  getActiveTrainingPlan,
  listTrainingPlans,
} from "@/lib/training-plans";

async function gate() {
  const auth = await requireAuth();
  if (isAuthFailure(auth)) return { error: auth as NextResponse };
  const limited = await withLimit(defaultLimiter(), auth.userId);
  if (limited) return { error: limited };
  return { userId: auth.userId };
}

// Every query below is scoped to the session user's id — a plan id alone is
// never enough to read or delete a plan. `plan` and `summary` are null when
// this athlete has no plan; there is no shared plan to fall back to.
async function planPayload(userId: string) {
  const [active, plans] = await Promise.all([
    getActiveTrainingPlan(userId),
    listTrainingPlans(userId),
  ]);
  return { plan: active?.plan ?? null, summary: active?.summary ?? null, plans };
}

export async function GET() {
  const g = await gate();
  if (g.error) return g.error;
  return NextResponse.json(await planPayload(g.userId));
}

export async function DELETE(request: NextRequest) {
  const g = await gate();
  if (g.error) return g.error;

  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  if (!(await deleteTrainingPlan(g.userId, id))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  // Deleting the active plan promotes the previous upload, or leaves the
  // athlete with no plan at all, so hand the caller what it should now render.
  return NextResponse.json(await planPayload(g.userId));
}
