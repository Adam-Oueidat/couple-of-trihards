import { NextRequest, NextResponse } from "next/server";
import { defaultLimiter } from "@trihards/core";
import { isAuthFailure, requireAuth } from "@/lib/auth";
import { withLimit } from "@/lib/api";
import {
  addWorkout,
  deleteWorkout,
  getWorkouts,
  updateWorkoutDate,
  validateWorkoutInput,
} from "@/lib/workouts";

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
  return NextResponse.json(await getWorkouts(g.userId));
}

export async function POST(request: NextRequest) {
  const g = await gate();
  if (g.error) return g.error;
  try {
    const input = validateWorkoutInput(await request.json());
    const workout = await addWorkout(g.userId, input, "athlete");
    return NextResponse.json(workout, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid workout" },
      { status: 400 },
    );
  }
}

export async function PATCH(request: NextRequest) {
  const g = await gate();
  if (g.error) return g.error;
  try {
    const body = await request.json();
    if (typeof body.id !== "string" || typeof body.date !== "string") {
      return NextResponse.json(
        { error: "id and date required" },
        { status: 400 },
      );
    }
    const updated = await updateWorkoutDate(g.userId, body.id, body.date);
    if (!updated) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(updated);
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
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  return (await deleteWorkout(g.userId, id))
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: "Not found" }, { status: 404 });
}
