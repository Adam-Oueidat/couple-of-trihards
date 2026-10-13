import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

// getDb() reads this lazily on first call and caches the connection, so setting
// it before any test body runs is enough to keep everything in memory.
process.env.TURSO_DATABASE_URL = ":memory:";

const MIGRATIONS_DIR = fileURLToPath(
  new URL("../../../../packages/db/migrations", import.meta.url),
);

const TODAY = "2026-10-13";

let userId: string;
let otherUserId: string;
let brain: typeof import("./brain");
let notes: typeof import("./brain-notes");

beforeAll(async () => {
  const { getDb, users } = await import("@trihards/db");
  const { sql } = await import("drizzle-orm");
  const db = getDb();

  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    const text = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    for (const stmt of text.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean)) {
      await db.run(sql.raw(stmt));
    }
  }

  const [a] = await db.insert(users).values({ stravaAthleteId: 7101 }).returning({ id: users.id });
  const [b] = await db.insert(users).values({ stravaAthleteId: 7102 }).returning({ id: users.id });
  userId = a.id;
  otherUserId = b.id;
  brain = await import("./brain");
  notes = await import("./brain-notes");
});

describe("checkNoteChanges", () => {
  const existing = [
    { id: "id-knee", kind: "health" as const, text: "Left knee sore on downhills", notedOn: "2026-09-20", rulesOut: [], until: null },
    { id: "id-wed", kind: "availability" as const, text: "Cannot train on Wednesdays", notedOn: "2026-09-01", rulesOut: [], until: null },
  ];

  it("maps refs back to the notes they were shown as", () => {
    const changes = notes.checkNoteChanges(
      { add: [], update: [{ ref: "n2", text: "Cannot train on Wednesdays or Fridays" }], retire: ["n1"] },
      existing,
    );
    expect(changes.retire).toEqual(["id-knee"]);
    expect(changes.update).toEqual([{ id: "id-wed", text: "Cannot train on Wednesdays or Fridays", rulesOut: [], until: null }]);
  });

  it("drops refs it was never shown, unknown kinds and repeats", () => {
    const changes = notes.checkNoteChanges(
      {
        add: [
          { kind: "mood", text: "Feeling great" },
          { kind: "availability", text: "cannot train on wednesdays" },
          { kind: "equipment", text: "Has no power meter" },
          { kind: "equipment", text: "Has no power meter" },
        ],
        update: [{ ref: "n9", text: "x" }, { ref: "n1", text: "Left knee sore on downhills" }],
        retire: ["n7", "id-knee"],
      },
      existing,
    );
    expect(changes.add).toEqual([{ kind: "equipment", text: "Has no power meter", rulesOut: [], until: null }]);
    expect(changes.update).toEqual([]);
    expect(changes.retire).toEqual([]);
  });

  it("caps how much one pass can add and survives junk", () => {
    const add = Array.from({ length: 9 }, (_, i) => ({ kind: "preference", text: `Likes thing ${i}` }));
    expect(notes.checkNoteChanges({ add }, []).add).toHaveLength(5);
    expect(notes.checkNoteChanges("not json", [])).toEqual({ add: [], update: [], retire: [] });
  });
});

describe("standing notes", () => {
  it("stores, rewrites and retires notes for one athlete only", async () => {
    await notes.applyNoteChanges(
      userId,
      {
        add: [
          { kind: "health", text: "Left knee sore on downhills", rulesOut: [], until: null },
          { kind: "availability", text: "Cannot train on Wednesdays", rulesOut: [], until: null },
        ],
        update: [],
        retire: [],
      },
      "plan_adjustment",
      "2026-10-01",
    );
    const [knee, wed] = ["health", "availability"].map(
      async (kind) => (await notes.getNotes(userId)).find((n) => n.kind === kind)!,
    );
    const kneeId = (await knee).id;
    const wedId = (await wed).id;

    // Another athlete can neither see these nor change them.
    expect(await notes.getNotes(otherUserId)).toEqual([]);
    await notes.applyNoteChanges(otherUserId, { add: [], update: [], retire: [kneeId] }, "chat", TODAY);
    expect(await notes.getNotes(userId)).toHaveLength(2);

    await notes.applyNoteChanges(
      userId,
      { add: [], update: [{ id: wedId, text: "Cannot train on Wednesdays or Fridays", rulesOut: [], until: null }], retire: [kneeId] },
      "chat",
      TODAY,
    );
    expect(await notes.getNotes(userId)).toEqual([
      { id: wedId, kind: "availability", text: "Cannot train on Wednesdays or Fridays", notedOn: TODAY, rulesOut: [], until: null },
    ]);
  });

  it("groups by kind and dates every note", () => {
    const text = notes.formatNotes(
      [
        { id: "a", kind: "availability", text: "Cannot train on Wednesdays", notedOn: "2026-10-12", rulesOut: [], until: null },
        { id: "b", kind: "health", text: "Left knee sore on downhills", notedOn: "2026-09-20", rulesOut: [], until: null },
      ],
      TODAY,
    )!;
    expect(text.indexOf("Health:")).toBeLessThan(text.indexOf("Availability:"));
    expect(text).toContain("- Left knee sore on downhills (said 2026-09-20, 23 days ago)");
    expect(text).toContain("(said 2026-10-12, yesterday)");
    expect(notes.formatNotes([], TODAY)).toBeNull();
  });
});

describe("sports a note rules out", () => {
  it("keeps only real sports, and an end date only alongside one", () => {
    const changes = notes.checkNoteChanges(
      {
        add: [
          { kind: "health", text: "Cannot swim, new tattoo", rules_out: ["swim", "yoga"], until: "2026-11-03" },
          { kind: "health", text: "Sore calf", rules_out: [], until: "2026-11-03" },
          { kind: "health", text: "Broken wrist", rules_out: ["ride"], until: "in three weeks" },
        ],
      },
      [],
    );
    expect(changes.add.map((a) => [a.rulesOut, a.until])).toEqual([
      [["swim"], "2026-11-03"],
      [[], null],
      [["ride"], null],
    ]);
  });

  it("is stored, shown to the coach and handed to the suggestion rules", async () => {
    await notes.applyNoteChanges(
      otherUserId,
      { add: [{ kind: "health", text: "Cannot swim, new tattoo", rulesOut: ["swim"], until: "2026-11-03" }], update: [], retire: [] },
      "chat",
      TODAY,
    );
    const stored = await notes.getNotes(otherUserId);
    expect(notes.ruledOutFrom(stored)).toEqual([
      { discipline: "swim", reason: "Cannot swim, new tattoo", until: "2026-11-03" },
    ]);
    expect(notes.formatNotes(stored, TODAY)).toContain("[rules out: swim until 2026-11-03]");

    // Lifting the restriction is an update the checker lets through.
    const lifted = notes.checkNoteChanges(
      { update: [{ ref: "n1", text: "Cannot swim, new tattoo", rules_out: [], until: "" }] },
      stored,
    );
    expect(lifted.update).toHaveLength(1);
    await notes.applyNoteChanges(otherUserId, { add: [], update: [], retire: [stored[0].id] }, "chat", TODAY);
  });
});

describe("formatPlanWork", () => {
  it("says whether a proposed change is actually in the plan", () => {
    const text = brain.formatPlanWork(
      null,
      [
        { date: "2026-10-10", request: "Knee is sore, go lighter", message: "Swapped two runs for rides.", outcome: "applied" },
        { date: "2026-10-05", request: "More swimming", message: "Added a swim.", outcome: "not applied" },
      ],
      TODAY,
    )!;
    expect(text.indexOf("2026-10-05")).toBeLessThan(text.indexOf("2026-10-10"));
    expect(text).toContain('2026-10-10 (3 days ago) they asked you to adjust the plan: "Knee is sore, go lighter"');
    expect(text).toContain("the plan sessions below already include it");
    expect(text).toContain("they did not apply it, so the plan is unchanged");
  });

  it("is null when the coach has done no plan work", () => {
    expect(brain.formatPlanWork(null, [], TODAY)).toBeNull();
  });
});

describe("recall", () => {
  it("says so when the memory is empty", async () => {
    const text = await brain.recall(otherUserId, [], TODAY);
    expect(text).toContain("# Coach memory");
    expect(text).toContain("Empty:");
  });

  it("brings notes, the written plan and analyses together", async () => {
    const { getDb, planDrafts } = await import("@trihards/db");
    const { saveAnalysis } = await import("./analyses");
    const db = getDb();
    const input = { prompt: "First 70.3 in June", startDate: "2026-10-19", maxHoursPerWeek: 8, unavailableDays: ["wed"] };
    const [first] = await db
      .insert(planDrafts)
      .values({ userId, status: "discarded", input })
      .returning({ id: planDrafts.id });
    await db.insert(planDrafts).values({
      userId,
      status: "saved",
      input,
      parentId: first.id,
      feedback: "More running please",
      result: { plan: { name: "70.3 build" }, why: "Base first, then race-specific work." },
    });
    // Someone else's saved draft must not leak in.
    await db.insert(planDrafts).values({
      userId: otherUserId,
      status: "saved",
      input: { prompt: "Marathon", startDate: "2026-10-19" },
      result: { plan: { name: "Someone else's plan" }, why: "" },
    });
    await saveAnalysis(userId, 42, "Strong tempo run.");

    const text = await brain.recall(userId, [], TODAY);
    expect(text).toContain("## Standing notes");
    expect(text).toContain("Cannot train on Wednesdays or Fridays");
    expect(text).toContain('You wrote the plan "70.3 build"');
    expect(text).toContain("at most 8 hours a week; nothing on wed");
    expect(text).toContain('"More running please"');
    expect(text).toContain("### Analysis of activity 42\nStrong tempo run.");
    expect(text).not.toContain("Someone else's plan");
    expect(text).not.toContain("Empty:");
  });
});
