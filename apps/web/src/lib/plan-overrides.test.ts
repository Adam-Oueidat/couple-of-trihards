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

let userId: string;
let setOverride: typeof import("./plan-overrides").setOverride;
let getOverrides: typeof import("./plan-overrides").getOverrides;
let validateOverrideInput: typeof import("./plan-overrides").validateOverrideInput;

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

  const [u] = await db.insert(users).values({ stravaAthleteId: 5150 }).returning({ id: users.id });
  userId = u.id;

  const mod = await import("./plan-overrides");
  setOverride = mod.setOverride;
  getOverrides = mod.getOverrides;
  validateOverrideInput = mod.validateOverrideInput;
});

const DATE = "2026-05-04";

describe("base-field edits round-trip", () => {
  it("persists a rename made without moving the session", async () => {
    // The row-deletion shortcut used to fire whenever the date was unchanged
    // and the session was not hidden, which wiped an edit like this one.
    await setOverride(userId, {
      sessionId: "s-rename",
      originalDate: DATE,
      newDate: DATE,
      name: "Club run",
    });

    const overrides = await getOverrides(userId);
    expect(overrides["s-rename"]).toBeDefined();
    expect(overrides["s-rename"].name).toBe("Club run");
  });

  it("persists type and distance edits", async () => {
    await setOverride(userId, {
      sessionId: "s-fields",
      originalDate: DATE,
      newDate: DATE,
      type: "tempo",
      km: 12.5,
    });

    const overrides = await getOverrides(userId);
    expect(overrides["s-fields"].type).toBe("tempo");
    expect(overrides["s-fields"].km).toBe(12.5);
  });

  it("still drops the row when nothing is left to record", async () => {
    await setOverride(userId, {
      sessionId: "s-moved",
      originalDate: DATE,
      newDate: "2026-05-06",
    });
    expect((await getOverrides(userId))["s-moved"]).toBeDefined();

    // Back to the plan's date, no hide, no field edits — nothing to store.
    const result = await setOverride(userId, {
      sessionId: "s-moved",
      originalDate: DATE,
      newDate: DATE,
    });

    expect(result).toBeNull();
    expect((await getOverrides(userId))["s-moved"]).toBeUndefined();
  });

  it("clears a field back to the plan when it is omitted on a later save", async () => {
    await setOverride(userId, {
      sessionId: "s-clear",
      originalDate: DATE,
      newDate: DATE,
      name: "Renamed",
      km: 9,
    });
    await setOverride(userId, {
      sessionId: "s-clear",
      originalDate: DATE,
      newDate: "2026-05-07",
    });

    const overrides = await getOverrides(userId);
    expect(overrides["s-clear"].name).toBeUndefined();
    expect(overrides["s-clear"].km).toBeUndefined();
    expect(overrides["s-clear"].newDate).toBe("2026-05-07");
  });
});

describe("skip round-trip", () => {
  it("persists the skip and its reason", async () => {
    await setOverride(userId, {
      sessionId: "s-skip",
      originalDate: DATE,
      newDate: DATE,
      skipped: true,
      skipReason: "calf was tight",
    });

    const overrides = await getOverrides(userId);
    expect(overrides["s-skip"].skipped).toBe(true);
    expect(overrides["s-skip"].skipReason).toBe("calf was tight");
    // A skip is not a removal — the session must stay in the plan.
    expect(overrides["s-skip"].hidden).toBe(false);
  });

  it("keeps the skip separate from the move reason", async () => {
    await setOverride(userId, {
      sessionId: "s-skip-moved",
      originalDate: DATE,
      newDate: "2026-05-06",
      reason: "work travel",
      skipped: true,
      skipReason: "never found the time",
    });

    const overrides = await getOverrides(userId);
    expect(overrides["s-skip-moved"].reason).toBe("work travel");
    expect(overrides["s-skip-moved"].skipReason).toBe("never found the time");
  });

  it("drops the row when the skip is the only thing on it and is undone", async () => {
    await setOverride(userId, {
      sessionId: "s-unskip",
      originalDate: DATE,
      newDate: DATE,
      skipped: true,
      skipReason: "sick",
    });
    expect((await getOverrides(userId))["s-unskip"]).toBeDefined();

    const result = await setOverride(userId, {
      sessionId: "s-unskip",
      originalDate: DATE,
      newDate: DATE,
      skipped: false,
    });

    expect(result).toBeNull();
    expect((await getOverrides(userId))["s-unskip"]).toBeUndefined();
  });

  it("keeps a row that still holds an edit after the skip is undone", async () => {
    await setOverride(userId, {
      sessionId: "s-unskip-edit",
      originalDate: DATE,
      newDate: DATE,
      name: "Club run",
      skipped: true,
      skipReason: "sick",
    });
    await setOverride(userId, {
      sessionId: "s-unskip-edit",
      originalDate: DATE,
      newDate: DATE,
      name: "Club run",
      skipped: false,
    });

    const row = (await getOverrides(userId))["s-unskip-edit"];
    expect(row.name).toBe("Club run");
    expect(row.skipped).toBe(false);
    // The reason goes with the skip, so the next skip cannot inherit a stale one.
    expect(row.skipReason).toBeUndefined();
  });
});

describe("validateOverrideInput", () => {
  const base = { sessionId: "s", originalDate: DATE, newDate: DATE };

  it("accepts omitted base fields", () => {
    const out = validateOverrideInput({ ...base });
    expect(out.name).toBeUndefined();
    expect(out.type).toBeUndefined();
    expect(out.km).toBeUndefined();
  });

  it("trims a name and rejects an empty one", () => {
    expect(validateOverrideInput({ ...base, name: "  Club run  " }).name).toBe("Club run");
    expect(() => validateOverrideInput({ ...base, name: "   " })).toThrow(/name/);
  });

  it("rejects a type outside the session-type union", () => {
    expect(() => validateOverrideInput({ ...base, type: "brick" })).toThrow(/type/);
    expect(validateOverrideInput({ ...base, type: "intervals" }).type).toBe("intervals");
  });

  it("rejects a non-boolean skipped flag", () => {
    expect(() => validateOverrideInput({ ...base, skipped: "yes" })).toThrow(/skipped/);
    expect(validateOverrideInput({ ...base, skipped: true }).skipped).toBe(true);
  });

  it("trims a skip reason, drops a blank one, and caps its length", () => {
    expect(
      validateOverrideInput({ ...base, skipped: true, skipReason: "  calf tight  " })
        .skipReason,
    ).toBe("calf tight");
    expect(
      validateOverrideInput({ ...base, skipped: true, skipReason: "   " }).skipReason,
    ).toBeUndefined();
    expect(
      validateOverrideInput({ ...base, skipped: true, skipReason: "x".repeat(500) })
        .skipReason,
    ).toHaveLength(300);
  });

  it("rejects a negative or non-finite distance but allows zero", () => {
    expect(() => validateOverrideInput({ ...base, km: -1 })).toThrow(/km/);
    expect(() => validateOverrideInput({ ...base, km: Number.NaN })).toThrow(/km/);
    expect(validateOverrideInput({ ...base, km: 0 }).km).toBe(0);
  });
});
