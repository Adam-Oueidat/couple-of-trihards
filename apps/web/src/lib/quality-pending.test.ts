import { describe, expect, it } from "vitest";
import type { StravaActivity } from "@trihards/core";
import {
  isQualityCandidate,
  pendingQuality,
  QUALITY_SCHEMA_VERSION,
} from "./quality-scan";
import { resolveZoneModel } from "@trihards/core";

const NOW = Math.floor(Date.parse("2026-09-22T10:00:00Z") / 1000);

let nextId = 1;
function run(date: string, over: Partial<StravaActivity> = {}): StravaActivity {
  return {
    id: nextId++,
    name: "Morning Run",
    sport_type: "Run",
    type: "Run",
    start_date: `${date}T08:00:00Z`,
    start_date_local: `${date}T08:00:00Z`,
    distance: 10000,
    moving_time: 3000,
    elapsed_time: 3100,
    manual: false,
    ...over,
  } as unknown as StravaActivity;
}

function row(
  activityId: string,
  over: Partial<{
    streamStatus: "ok" | "partial" | "none" | "error";
    attempts: number;
    schemaVersion: number;
    derivedAt: number;
  }> = {},
) {
  return {
    activityId,
    streamStatus: "ok" as const,
    attempts: 1,
    schemaVersion: QUALITY_SCHEMA_VERSION,
    derivedAt: NOW,
    ...over,
  };
}

describe("pendingQuality", () => {
  it("returns activities that have never been derived", () => {
    const acts = [run("2026-09-01"), run("2026-09-02")];
    expect(pendingQuality(acts, [], { now: NOW })).toHaveLength(2);
  });

  it("works newest first, so an interrupted scan answers the useful half", () => {
    const acts = [run("2026-01-05"), run("2026-09-20"), run("2026-05-10")];
    const order = pendingQuality(acts, [], { now: NOW }).map((a) =>
      a.start_date_local.slice(0, 10),
    );
    expect(order).toEqual(["2026-09-20", "2026-05-10", "2026-01-05"]);
  });

  it("leaves already-derived activities alone", () => {
    const a = run("2026-09-01");
    expect(pendingQuality([a], [row(String(a.id))], { now: NOW })).toHaveLength(0);
  });

  it("re-derives everything after a schema bump", () => {
    const a = run("2026-09-01");
    const stale = [row(String(a.id), { schemaVersion: QUALITY_SCHEMA_VERSION - 1 })];
    expect(pendingQuality([a], stale, { now: NOW })).toHaveLength(1);
  });

  it("never retries an activity that has no streams to give", () => {
    // A manual entry or one Strava 404s on will not grow a heart-rate trace.
    // Retrying forever would spend a read per scan on a known dead end.
    const a = run("2026-09-01");
    const dead = [row(String(a.id), { streamStatus: "none", attempts: 1 })];
    expect(pendingQuality([a], dead, { now: NOW })).toHaveLength(0);
  });

  it("retries a transient failure, but not immediately", () => {
    const a = run("2026-09-01");
    const justFailed = [row(String(a.id), { streamStatus: "error", derivedAt: NOW - 60 })];
    expect(pendingQuality([a], justFailed, { now: NOW })).toHaveLength(0);

    const dayOld = [
      row(String(a.id), { streamStatus: "error", derivedAt: NOW - 25 * 3600 }),
    ];
    expect(pendingQuality([a], dayOld, { now: NOW })).toHaveLength(1);
  });

  it("gives up on a permanently broken activity after three attempts", () => {
    const a = run("2026-09-01");
    const exhausted = [
      row(String(a.id), {
        streamStatus: "error",
        attempts: 3,
        derivedAt: NOW - 25 * 3600,
      }),
    ];
    expect(pendingQuality([a], exhausted, { now: NOW })).toHaveLength(0);
  });

  it("skips manual activities, which have nothing to read", () => {
    expect(pendingQuality([run("2026-09-01", { manual: true })], [], { now: NOW })).toHaveLength(0);
  });

  it("skips disciplines outside swim, ride and run", () => {
    const walk = run("2026-09-01", { sport_type: "Walk", type: "Walk" });
    expect(pendingQuality([walk], [], { now: NOW })).toHaveLength(0);
  });
});

describe("isQualityCandidate", () => {
  const model = resolveZoneModel(
    {
      heart_rate: {
        custom_zones: false,
        zones: [
          { min: 0, max: 133 },
          { min: 133, max: 165 },
          { min: 165, max: 182 },
          { min: 182, max: 198 },
          { min: 198, max: -1 },
        ],
      },
    },
    200,
  );

  it("recognises the athlete's own workout names", () => {
    // Real names from their history. A second Strava read per activity is only
    // worth spending where structure is plausible.
    for (const name of [
      "400m Repeats",
      "Rolling 300s",
      "Tempo 4-3-2-1",
      "Drop Set",
      "800m into 400m Intervals",
      "Descending Intervals",
      "Brukade hata Fartlek",
    ]) {
      expect(isQualityCandidate(run("2026-09-01", { name }), model)).toBe(true);
    }
  });

  it("spends nothing on a plainly easy run", () => {
    const easy = run("2026-09-01", { name: "14km Easy Run", average_heartrate: 148 });
    expect(isQualityCandidate(easy, model)).toBe(false);
  });

  it("still fetches an unnamed session that ran hard", () => {
    // A Z3 average is either a sustained hard effort or a mixed one; both are
    // worth the lap file even when the name says nothing.
    const hard = run("2026-09-01", { name: "Afternoon Run", average_heartrate: 170 });
    expect(isQualityCandidate(hard, model)).toBe(true);
  });

  it("falls back to names alone when there are no zones", () => {
    const none = resolveZoneModel(null, null);
    expect(isQualityCandidate(run("2026-09-01", { name: "Drop Set" }), none)).toBe(true);
    expect(
      isQualityCandidate(run("2026-09-01", { name: "Morning Run", average_heartrate: 190 }), none),
    ).toBe(false);
  });
});
