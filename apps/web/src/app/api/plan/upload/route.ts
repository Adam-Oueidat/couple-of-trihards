import { NextRequest, NextResponse } from "next/server";
import { analyzeLimiter, createLogger } from "@trihards/core";
import { isAuthFailure, requireAuth } from "@/lib/auth";
import { withLimit } from "@/lib/api";
import {
  MAX_PLAN_UPLOAD_BYTES,
  parsePlanDocument,
  PlanIngestError,
  resolvePlanMediaType,
} from "@/lib/plan-ingest";
import {
  getActiveTrainingPlan,
  listTrainingPlans,
  saveTrainingPlan,
} from "@/lib/training-plans";

const log = createLogger("api:plan-upload");

// Reading a plan document is a model call over a whole PDF, so it can outlast
// the default serverless budget.
export const maxDuration = 300;
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if (isAuthFailure(auth)) return auth;
  const { userId } = auth;

  // The plan parser is an LLM call over a whole document, so it shares the
  // per-hour budget with activity analysis rather than the cheap default one.
  const limited = await withLimit(analyzeLimiter(), userId);
  if (limited) return limited;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json(
      { error: "Upload a plan document as multipart form data." },
      { status: 400 },
    );
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file was uploaded." }, { status: 400 });
  }

  // Check the declared size before reading the body into memory, so an
  // oversized upload is rejected without being buffered first.
  if (file.size > MAX_PLAN_UPLOAD_BYTES) {
    return NextResponse.json(
      {
        error: `Plan documents must be ${Math.round(MAX_PLAN_UPLOAD_BYTES / (1024 * 1024))} MB or smaller.`,
      },
      { status: 413 },
    );
  }

  const mediaType = resolvePlanMediaType(file.type, file.name);
  if (!mediaType) {
    return NextResponse.json(
      { error: "Upload the plan as a PDF, Markdown, or text file." },
      { status: 415 },
    );
  }

  const data = Buffer.from(await file.arrayBuffer());
  log.info("plan upload received", { userId, mediaType, bytes: data.byteLength });

  try {
    const raw = await parsePlanDocument({
      data,
      mediaType,
      fileName: file.name,
    });
    // saveTrainingPlan re-validates before writing, so nothing reaches the
    // database that the plan schema would reject on read.
    const summary = await saveTrainingPlan(userId, raw);
    const [active, plans] = await Promise.all([
      getActiveTrainingPlan(userId),
      listTrainingPlans(userId),
    ]);
    return NextResponse.json(
      { summary, plan: active?.plan ?? null, plans },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof PlanIngestError) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    log.error("plan upload failed", err);
    return NextResponse.json(
      { error: "Could not read that plan. Try again in a moment." },
      { status: 500 },
    );
  }
}
