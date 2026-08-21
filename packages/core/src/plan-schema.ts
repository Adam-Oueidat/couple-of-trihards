import {
  SESSION_TYPES,
  type RawPlannedSession,
  type RawTrainingPlan,
  type SessionType,
} from "./plan";

// Validation for authored training plans. Two callers share it: the PDF
// ingestion route (which must never persist whatever the model happened to
// return) and the plan reader (which must never trust a JSON column written by
// an older schema version). Keeping it in core means the db package and the web
// app agree on exactly one definition of "a valid plan".

export const MAX_PLAN_SESSIONS = 1000;
const MAX_NAME_LENGTH = 120;
const MAX_KM = 500;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * JSON Schema handed to the model as `output_config.format`, so the parsed
 * document comes back already shaped like a `RawTrainingPlan`. Deliberately
 * free of numeric/length constraints — structured outputs does not support
 * them, and `parseRawTrainingPlan` enforces the bounds after the fact.
 */
export const TRAINING_PLAN_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "name",
    "source",
    "discipline",
    "startDate",
    "raceDate",
    "raceName",
    "sessions",
  ],
  properties: {
    name: {
      type: "string",
      description: "Title of the plan, e.g. 'Copenhagen Half Marathon Plan'.",
    },
    source: {
      type: "string",
      description:
        "Who produced the plan (e.g. 'Runna', 'Coach', 'TrainingPeaks'). Use 'Upload' if the document does not say.",
    },
    discipline: {
      type: "string",
      enum: ["run", "ride", "swim"],
      description: "The single discipline this plan prescribes.",
    },
    startDate: {
      type: "string",
      format: "date",
      description: "ISO date (YYYY-MM-DD) of the plan's first session.",
    },
    raceDate: {
      type: "string",
      format: "date",
      description: "ISO date (YYYY-MM-DD) of the goal race.",
    },
    raceName: {
      type: "string",
      description: "Name of the goal race.",
    },
    sessions: {
      type: "array",
      description:
        "Every prescribed session in the plan, one entry per session, in date order. Rest days are omitted.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["date", "name", "type", "km"],
        properties: {
          date: {
            type: "string",
            format: "date",
            description: "ISO date (YYYY-MM-DD) the session is scheduled for.",
          },
          name: {
            type: "string",
            description:
              "Short session title as written in the document, e.g. '400m Repeats' or '17km Long Run'.",
          },
          type: {
            type: "string",
            enum: [...SESSION_TYPES],
            description:
              "easy = recovery/base; intervals = repeats or fartlek; tempo = threshold or progression; long = the week's long session; time_trial = a timed test; race = the goal race itself.",
          },
          km: {
            type: "number",
            description:
              "Total session distance in kilometres. Convert from miles when needed; estimate from duration and pace when the document gives only a duration.",
          },
        },
      },
    },
  },
};

function fail(message: string): never {
  throw new Error(message);
}

function requireString(
  value: unknown,
  field: string,
  maxLength = MAX_NAME_LENGTH,
): string {
  if (typeof value !== "string") fail(`${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length === 0) fail(`${field} is required`);
  if (trimmed.length > maxLength) fail(`${field} must be ${maxLength} characters or fewer`);
  return trimmed;
}

// Rejects both the wrong shape and impossible calendar dates ("2026-02-31"),
// which a regex alone would let through.
function requireDate(value: unknown, field: string): string {
  const raw = requireString(value, field, 10);
  if (!DATE_RE.test(raw)) fail(`${field} must be an ISO date (YYYY-MM-DD)`);
  const parsed = new Date(`${raw}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) fail(`${field} is not a real date`);
  if (parsed.toISOString().slice(0, 10) !== raw) fail(`${field} is not a real date`);
  return raw;
}

function requireSessionType(value: unknown, field: string): SessionType {
  if (typeof value !== "string" || !SESSION_TYPES.includes(value as SessionType)) {
    fail(`${field} must be one of: ${SESSION_TYPES.join(", ")}`);
  }
  return value as SessionType;
}

function requireKm(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${field} must be a number`);
  }
  if (value < 0 || value > MAX_KM) fail(`${field} must be between 0 and ${MAX_KM}`);
  return Math.round(value * 100) / 100;
}

/**
 * Validate an untrusted plan object and return it normalised: trimmed strings,
 * rounded distances, and sessions sorted by date so the calendar and the plan
 * list read in order whatever order the source produced them in. Throws an
 * `Error` whose message is safe to show the athlete.
 */
export function parseRawTrainingPlan(input: unknown): RawTrainingPlan {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("Plan must be a JSON object");
  }
  const o = input as Record<string, unknown>;

  const name = requireString(o.name, "name");
  const source = requireString(o.source, "source", 60);
  const discipline = requireString(o.discipline, "discipline", 20).toLowerCase();
  if (discipline !== "run" && discipline !== "ride" && discipline !== "swim") {
    fail("discipline must be run, ride, or swim");
  }
  const startDate = requireDate(o.startDate, "startDate");
  const raceDate = requireDate(o.raceDate, "raceDate");
  const raceName = requireString(o.raceName, "raceName");

  if (raceDate < startDate) fail("raceDate must be on or after startDate");

  if (!Array.isArray(o.sessions)) fail("sessions must be an array");
  if (o.sessions.length === 0) {
    fail("No sessions found in the plan");
  }
  if (o.sessions.length > MAX_PLAN_SESSIONS) {
    fail(`A plan can hold at most ${MAX_PLAN_SESSIONS} sessions`);
  }

  const sessions: RawPlannedSession[] = o.sessions.map((entry, i) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      fail(`sessions[${i}] must be an object`);
    }
    const s = entry as Record<string, unknown>;
    return {
      date: requireDate(s.date, `sessions[${i}].date`),
      name: requireString(s.name, `sessions[${i}].name`),
      type: requireSessionType(s.type, `sessions[${i}].type`),
      km: requireKm(s.km, `sessions[${i}].km`),
    };
  });

  sessions.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  return { name, source, discipline, startDate, raceDate, raceName, sessions };
}
