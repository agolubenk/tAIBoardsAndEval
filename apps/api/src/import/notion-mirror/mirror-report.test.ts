import { describe, expect, it } from "vite-plus/test";
import {
  cleanStreak,
  type MirrorDatabaseReport,
  type MirrorRunTime,
  runStatusOf,
} from "./mirror-report";

const NOW = new Date("2026-10-30T12:00:00.000Z");

function at(hoursAgo: number, status: MirrorRunTime["status"] = "clean") {
  return { status, startedAt: new Date(NOW.getTime() - hoursAgo * 3_600_000) };
}

function report(patch: Partial<MirrorDatabaseReport>): MirrorDatabaseReport {
  return {
    databaseId: "db",
    name: "Tasks",
    read: { pages: 0, fresh: 0, changed: 0 },
    totals: { source: 0, imported: 0 },
    byStatus: {},
    byType: {},
    discrepancyCount: 0,
    discrepancies: [],
    error: null,
    ...patch,
  };
}

describe("runStatusOf", () => {
  it("is failed when any database failed, before discrepancies", () => {
    expect(
      runStatusOf([report({ discrepancyCount: 3 }), report({ error: "x" })]),
    ).toBe("failed");
  });

  it("is discrepancies when any database disagrees", () => {
    expect(runStatusOf([report({}), report({ discrepancyCount: 1 })])).toBe(
      "discrepancies",
    );
  });

  it("is clean otherwise", () => {
    expect(runStatusOf([report({})])).toBe("clean");
  });
});

describe("cleanStreak", () => {
  it("counts clean runs back to the first broken one", () => {
    const streak = cleanStreak(
      [at(1), at(3), at(5), at(7, "discrepancies"), at(9)],
      NOW,
      5,
    );
    expect(streak).toEqual({
      runs: 3,
      since: at(5).startedAt,
      hours: 5,
      brokenBy: "discrepancies",
    });
  });

  it("skips a run still in progress", () => {
    const streak = cleanStreak([at(0.1, "running"), at(1), at(3)], NOW, 5);
    expect(streak.runs).toBe(2);
    expect(streak.brokenBy).toBeNull();
  });

  it("breaks on a gap between runs", () => {
    const streak = cleanStreak([at(1), at(3), at(9)], NOW, 5);
    expect(streak.runs).toBe(2);
    expect(streak.brokenBy).toBe("gap");
  });

  it("is empty when no run finished recently", () => {
    expect(cleanStreak([at(6), at(8)], NOW, 5)).toEqual({
      runs: 0,
      since: null,
      hours: 0,
      brokenBy: "gap",
    });
  });

  it("is empty when the newest run failed", () => {
    expect(cleanStreak([at(1, "failed"), at(3)], NOW, 5)).toMatchObject({
      runs: 0,
      since: null,
      brokenBy: "failed",
    });
  });
});
