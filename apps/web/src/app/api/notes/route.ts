import { NextRequest, NextResponse } from "next/server";
import { defaultLimiter } from "@trihards/core";
import { isAuthFailure, requireAuth } from "@/lib/auth";
import { withLimit } from "@/lib/api";
import { archiveNote, getNotes } from "@/lib/brain-notes";

// What the coach remembers about the athlete (the standing notes of brain.ts).
// Read-only apart from removal: notes are written by learnFromAthlete alone.
export async function GET() {
  const auth = await requireAuth();
  if (isAuthFailure(auth)) return auth;
  const limited = await withLimit(defaultLimiter(), auth.userId);
  if (limited) return limited;
  return NextResponse.json(await getNotes(auth.userId));
}

/** Forget a note: DELETE /api/notes?id=…. Archives it, like a retired note. */
export async function DELETE(request: NextRequest) {
  const auth = await requireAuth();
  if (isAuthFailure(auth)) return auth;
  const limited = await withLimit(defaultLimiter(), auth.userId);
  if (limited) return limited;

  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  return (await archiveNote(auth.userId, id))
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: "Not found" }, { status: 404 });
}
