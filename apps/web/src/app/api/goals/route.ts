import { NextRequest, NextResponse } from "next/server";
import { defaultLimiter } from "@trihards/core";
import { isAuthFailure, requireAuth } from "@/lib/auth";
import { withLimit } from "@/lib/api";
import { addGoal, deleteGoal, getGoals, setGoalArchived } from "@/lib/goals";

export async function GET() {
  const auth = await requireAuth();
  if (isAuthFailure(auth)) return auth;
  const limited = await withLimit(defaultLimiter(), auth.userId);
  if (limited) return limited;
  return NextResponse.json(await getGoals(auth.userId));
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if (isAuthFailure(auth)) return auth;
  const limited = await withLimit(defaultLimiter(), auth.userId);
  if (limited) return limited;

  try {
    const body = await request.json();
    const goal = await addGoal(auth.userId, body.text);
    return NextResponse.json(goal, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid goal" },
      { status: 400 },
    );
  }
}

/** Archive or restore a goal: PATCH /api/goals?id=… with { archived: boolean }. */
export async function PATCH(request: NextRequest) {
  const auth = await requireAuth();
  if (isAuthFailure(auth)) return auth;
  const limited = await withLimit(defaultLimiter(), auth.userId);
  if (limited) return limited;

  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const body = await request.json().catch(() => null);
  if (typeof body?.archived !== "boolean") {
    return NextResponse.json({ error: "archived must be true or false" }, { status: 400 });
  }

  const goal = await setGoalArchived(auth.userId, id, body.archived);
  return goal
    ? NextResponse.json(goal)
    : NextResponse.json({ error: "Not found" }, { status: 404 });
}

export async function DELETE(request: NextRequest) {
  const auth = await requireAuth();
  if (isAuthFailure(auth)) return auth;
  const limited = await withLimit(defaultLimiter(), auth.userId);
  if (limited) return limited;

  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  return (await deleteGoal(auth.userId, id))
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: "Not found" }, { status: 404 });
}
