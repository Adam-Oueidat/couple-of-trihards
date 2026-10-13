import Anthropic from "@anthropic-ai/sdk";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { athleteNotes, getDb, type AthleteNoteRow } from "@trihards/db";
import { createLogger, SUMMARY_MODEL } from "@trihards/core";
import { daysBetween } from "./coach-dates";

const log = createLogger("brain-notes");
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// The long-term half of the brain (see brain.ts): what the athlete has said
// that stays true past this week and cannot be read from their data. Chat
// recaps reach back two weeks; a sore knee or "never on Wednesdays" has to
// outlive that, and has to reach the plan writer as well as the chat.
//
// There is one way in. Whatever surface the athlete spoke to hands their words
// to learnFromAthlete, which reads them against the notes as they stand and
// decides what changes. No surface writes a note itself, so two of them cannot
// record the same thing twice or disagree about it.

export const NOTE_KINDS = [
  "health",
  "availability",
  "preference",
  "equipment",
  "background",
  "agreement",
] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];
export type NoteSource = AthleteNoteRow["source"];

export interface AthleteNote {
  id: string;
  kind: NoteKind;
  text: string;
  // Athlete-local date it was said or last confirmed, YYYY-MM-DD.
  notedOn: string;
}

// How many notes a prompt carries, and the bounds on one learning pass.
const MAX_NOTES = 40;
const MAX_NOTE_CHARS = 300;
const MAX_ADDS = 5;
const MAX_MATERIAL_CHARS = 12000;

const KIND_LABEL: Record<NoteKind, string> = {
  health: "Health",
  availability: "Availability",
  preference: "Preferences",
  equipment: "Equipment",
  background: "Background",
  agreement: "Standing agreements",
};

// The athlete's live notes, newest first.
export async function getNotes(userId: string): Promise<AthleteNote[]> {
  const rows = await getDb()
    .select()
    .from(athleteNotes)
    .where(and(eq(athleteNotes.userId, userId), isNull(athleteNotes.archivedAt)))
    .orderBy(desc(athleteNotes.notedOn), desc(athleteNotes.createdAt))
    .limit(MAX_NOTES);
  return rows.map((r) => ({ id: r.id, kind: r.kind, text: r.text, notedOn: r.notedOn }));
}

// The body of the "Standing notes" section, grouped by kind, or null when
// there are none. Each note carries the day it was said: a niggle from four
// months ago and one from last week are not the same fact.
export function formatNotes(notes: AthleteNote[], today: string): string | null {
  if (notes.length === 0) return null;
  return NOTE_KINDS.flatMap((kind) => {
    const of = notes.filter((n) => n.kind === kind);
    if (of.length === 0) return [];
    return [
      `${KIND_LABEL[kind]}:`,
      ...of.map((n) => {
        const days = daysBetween(n.notedOn, today);
        const ago = days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
        return `- ${n.text} (said ${n.notedOn}, ${ago})`;
      }),
    ];
  }).join("\n");
}

export interface NoteChanges {
  add: { kind: NoteKind; text: string }[];
  update: { id: string; text: string }[];
  retire: string[];
}

const NOTE_CHANGES_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["add", "update", "retire"],
  properties: {
    add: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "text"],
        properties: {
          kind: { type: "string", enum: NOTE_KINDS },
          text: { type: "string" },
        },
      },
    },
    update: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["ref", "text"],
        properties: { ref: { type: "string" }, text: { type: "string" } },
      },
    },
    retire: { type: "array", items: { type: "string" } },
  },
};

const LEARN_SYSTEM_PROMPT = `You keep the long-term notes a triathlon coach holds about one athlete. You are given the notes as they stand, then something the athlete has just said to the coach: a chat, a request for a training plan, or a request to change one. Decide what, if anything, changes in the notes.

A note is worth keeping only if it will still matter weeks from now and cannot be read from the athlete's training data:
- health: an injury, niggle, illness or condition, and what it rules out.
- availability: days or times they can or cannot train, shift or travel patterns, when they can get to a pool.
- preference: what they like or dislike, and how they want to be coached.
- equipment: kit they have or lack (power meter, indoor trainer, wetsuit, pool length).
- background: experience and history (first triathlon, former swimmer, came back from a long break).
- agreement: a standing rule the athlete and coach settled, e.g. "long runs capped at 18 km until the knee settles".

Do not keep:
- One-off scheduling: a rest day taken, a session moved, skipped or added, how this week was reshaped. Those are recorded elsewhere.
- Anything the app already tracks: goals, races and race dates, personal bests, paces, heart rate, training volume, the sessions in their plan.
- The coach's advice or opinions, unless the athlete agreed to them as a standing rule.
- Guesses. Record only what the athlete said themselves. In a chat the coach's lines are there for context, not as facts.

How to answer:
- add: a new note. One fact per note, one plain sentence in the third person without their name ("Works night shifts Thursday to Saturday"). Write any date as a calendar date, worked out from the date given, never as "last week".
- update: an existing note that has changed or gained detail. Give its ref and the whole note rewritten. Do not update a note that is merely mentioned again unchanged.
- retire: the ref of a note the athlete says is no longer true (the knee is fine again, they bought a power meter) or that a new note replaces.
- Never add a note that repeats an existing one.
- Most of what an athlete says changes nothing. When that is so, return three empty lists.`;

// Drop anything the model returned that the store should not take: a kind that
// does not exist, a ref it was never shown, a note already there, too many at
// once. Pure, so the rules can be tested without a model.
export function checkNoteChanges(raw: unknown, existing: AthleteNote[]): NoteChanges {
  const out: NoteChanges = { add: [], update: [], retire: [] };
  if (!raw || typeof raw !== "object") return out;
  const { add, update, retire } = raw as Record<string, unknown>;
  const byRef = new Map(existing.map((n, i) => [`n${i + 1}`, n]));
  const clean = (v: unknown) =>
    typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, MAX_NOTE_CHARS) : "";
  const known = new Set(existing.map((n) => n.text.toLowerCase()));

  for (const ref of Array.isArray(retire) ? retire : []) {
    const note = typeof ref === "string" ? byRef.get(ref) : undefined;
    if (note && !out.retire.includes(note.id)) out.retire.push(note.id);
  }
  for (const item of Array.isArray(update) ? update : []) {
    const { ref, text } = (item ?? {}) as Record<string, unknown>;
    const note = typeof ref === "string" ? byRef.get(ref) : undefined;
    const next = clean(text);
    if (!note || !next || out.retire.includes(note.id) || next === note.text) continue;
    if (out.update.some((u) => u.id === note.id)) continue;
    out.update.push({ id: note.id, text: next });
  }
  for (const item of Array.isArray(add) ? add : []) {
    if (out.add.length >= MAX_ADDS) break;
    const { kind, text } = (item ?? {}) as Record<string, unknown>;
    const next = clean(text);
    if (!NOTE_KINDS.includes(kind as NoteKind) || !next) continue;
    if (known.has(next.toLowerCase())) continue;
    known.add(next.toLowerCase());
    out.add.push({ kind: kind as NoteKind, text: next });
  }
  return out;
}

export async function applyNoteChanges(
  userId: string,
  changes: NoteChanges,
  source: NoteSource,
  date: string,
): Promise<void> {
  const db = getDb();
  if (changes.retire.length) {
    await db
      .update(athleteNotes)
      .set({ archivedAt: Math.floor(Date.now() / 1000) })
      .where(and(eq(athleteNotes.userId, userId), inArray(athleteNotes.id, changes.retire)));
  }
  for (const u of changes.update) {
    await db
      .update(athleteNotes)
      .set({ text: u.text, notedOn: date })
      .where(and(eq(athleteNotes.userId, userId), eq(athleteNotes.id, u.id)));
  }
  if (changes.add.length) {
    await db
      .insert(athleteNotes)
      .values(changes.add.map((a) => ({ userId, kind: a.kind, text: a.text, source, notedOn: date })));
  }
}

const MATERIAL_LABEL: Record<NoteSource, string> = {
  chat: "A chat between the athlete and the coach",
  plan_request: "The athlete asked the coach to write or revise a training plan",
  plan_adjustment: "The athlete asked the coach to adjust their training plan",
};

// Read what the athlete said against their notes and store whatever changes.
// Best-effort and never throws: memory must not cost the athlete the reply or
// the plan they actually asked for.
export async function learnFromAthlete(
  userId: string,
  material: { source: NoteSource; date: string; text: string },
): Promise<void> {
  const said = material.text.trim().slice(-MAX_MATERIAL_CHARS);
  if (!said) return;
  try {
    const existing = await getNotes(userId);
    const notes =
      existing.map((n, i) => `[n${i + 1}] (${n.kind}, said ${n.notedOn}) ${n.text}`).join("\n") ||
      "None yet.";
    const res = await anthropic.messages.create({
      model: SUMMARY_MODEL,
      max_tokens: 1000,
      system: LEARN_SYSTEM_PROMPT,
      output_config: { format: { type: "json_schema", schema: NOTE_CHANGES_SCHEMA } },
      messages: [
        {
          role: "user",
          content: `## Notes as they stand\n${notes}\n\n## ${MATERIAL_LABEL[material.source]} on ${material.date}\n${said}`,
        },
      ],
    });
    if (res.stop_reason !== "end_turn") return;
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const changes = checkNoteChanges(JSON.parse(text), existing);
    await applyNoteChanges(userId, changes, material.source, material.date);
    if (changes.add.length || changes.update.length || changes.retire.length) {
      log.info("notes updated", {
        userId,
        source: material.source,
        added: changes.add.length,
        updated: changes.update.length,
        retired: changes.retire.length,
      });
    }
  } catch (err) {
    log.warn("learning failed", {
      userId,
      source: material.source,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
