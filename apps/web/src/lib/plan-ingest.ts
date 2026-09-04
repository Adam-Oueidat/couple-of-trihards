import Anthropic from "@anthropic-ai/sdk";
import {
  createLogger,
  parseRawTrainingPlan,
  PLAN_PARSE_MODEL,
  TRAINING_PLAN_JSON_SCHEMA,
  type RawTrainingPlan,
} from "@trihards/core";

const log = createLogger("plan-ingest");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Largest plan document we accept. A training plan is a handful of pages, so
 * 10 MB is generous; it also keeps the base64-encoded document (which inflates
 * by 4/3) comfortably inside the Messages API's 32 MB request limit.
 */
export const MAX_PLAN_UPLOAD_BYTES = 10 * 1024 * 1024;

export const ACCEPTED_PLAN_MEDIA_TYPES = [
  "application/pdf",
  "text/plain",
  "text/markdown",
] as const;

export type PlanMediaType = (typeof ACCEPTED_PLAN_MEDIA_TYPES)[number];

export class PlanIngestError extends Error {}

/** Maps a browser-supplied file name / MIME type onto a type we can send. */
export function resolvePlanMediaType(
  mimeType: string | undefined,
  fileName: string | undefined,
): PlanMediaType | null {
  const mime = (mimeType ?? "").split(";")[0].trim().toLowerCase();
  if (mime === "application/pdf") return "application/pdf";
  if (mime === "text/markdown") return "text/markdown";
  if (mime === "text/plain") return "text/plain";

  // Some browsers send an empty or generic type for drag-and-dropped files, so
  // fall back to the extension rather than rejecting a perfectly good PDF.
  const name = (fileName ?? "").toLowerCase();
  if (name.endsWith(".pdf")) return "application/pdf";
  if (name.endsWith(".md")) return "text/markdown";
  if (name.endsWith(".txt")) return "text/plain";
  return null;
}

const SYSTEM_PROMPT = `You transcribe an athlete's training plan document into structured data for a training log.

Transcribe only what the document prescribes. Do not invent sessions, weeks, or a goal race that the document does not contain, and do not fill gaps with a plan of your own design.

Rules:
- One entry per prescribed session. Omit rest days entirely.
- Two sessions on the same day are two entries with the same date.
- Distances are kilometres. Convert miles (1 mi = 1.609 km). When the document prescribes only a duration, estimate the distance from the prescribed pace, or from an easy pace for the discipline if none is given.
- For interval and repeat sessions, km is the total session distance including warm-up, recoveries, and cool-down.
- Dates are absolute ISO dates. When the document gives relative weeks ("Week 3, Tuesday"), count forward from the plan's start date.
- Set source to whoever produced the plan (the app or coach named in the document); use "Upload" only when the document does not say.

If the document is not a training plan, return an empty sessions array.`;

const USER_INSTRUCTION =
  "Transcribe this training plan document into the structured plan format. Include every prescribed session from the first week through race day.";

interface ParseInput {
  data: Buffer;
  mediaType: PlanMediaType;
  fileName?: string;
}

/**
 * Send a plan document to Claude and get back a validated `RawTrainingPlan`.
 *
 * Uses structured outputs so the model returns the plan already shaped like the
 * stored schema, then re-validates that output with `parseRawTrainingPlan` —
 * the schema constrains the shape, but the dates, distances, and session count
 * still have to be checked before anything is persisted.
 */
export async function parsePlanDocument(
  input: ParseInput,
): Promise<RawTrainingPlan> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new PlanIngestError("Plan parsing is not configured on this server.");
  }
  if (input.data.byteLength === 0) {
    throw new PlanIngestError("The uploaded file is empty.");
  }
  if (input.data.byteLength > MAX_PLAN_UPLOAD_BYTES) {
    throw new PlanIngestError(
      `Plan documents must be ${Math.round(MAX_PLAN_UPLOAD_BYTES / (1024 * 1024))} MB or smaller.`,
    );
  }

  const document: Anthropic.DocumentBlockParam =
    input.mediaType === "application/pdf"
      ? {
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: input.data.toString("base64"),
          },
          title: input.fileName,
        }
      : {
          type: "document",
          source: {
            type: "text",
            media_type: "text/plain",
            data: input.data.toString("utf8"),
          },
          title: input.fileName,
        };

  // Streamed because a full plan plus adaptive thinking can run well past the
  // point where a non-streaming request risks an HTTP timeout.
  const stream = anthropic.messages.stream({
    model: PLAN_PARSE_MODEL,
    max_tokens: 32000,
    system: SYSTEM_PROMPT,
    output_config: {
      effort: "high",
      format: { type: "json_schema", schema: TRAINING_PLAN_JSON_SCHEMA },
    },
    messages: [
      {
        role: "user",
        content: [document, { type: "text", text: USER_INSTRUCTION }],
      },
    ],
  });

  const message = await stream.finalMessage();

  if (message.stop_reason === "refusal") {
    log.warn("plan parse refused", { category: message.stop_details?.category });
    throw new PlanIngestError(
      "The document could not be processed. Try a different export of your plan.",
    );
  }
  if (message.stop_reason === "max_tokens") {
    throw new PlanIngestError(
      "That plan is too long to read in one pass. Try uploading it in shorter blocks.",
    );
  }

  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

  if (!text.trim()) {
    throw new PlanIngestError("No training plan could be read from that document.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    log.error("plan parse returned non-JSON output", { length: text.length });
    throw new PlanIngestError("No training plan could be read from that document.");
  }

  try {
    const raw = parseRawTrainingPlan(parsed);
    log.info("plan parsed", {
      sessions: raw.sessions.length,
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
    });
    return raw;
  } catch (err) {
    // The model produced schema-shaped output that still isn't a usable plan
    // (no sessions, an impossible date, a race before the start). Surface the
    // reason — it usually tells the athlete what the document was missing.
    throw new PlanIngestError(
      err instanceof Error ? err.message : "That document is not a training plan.",
    );
  }
}
