import type {
  NotionReconcileDiscrepancy,
  NotionReconcileSide,
} from "@kaneo/importers";

export type MirrorRunStatus = "running" | "clean" | "discrepancies" | "failed";

export type MirrorDatabaseReport = {
  databaseId: string;
  name: string;
  // What this run brought over: pages without a card, pages Notion edited.
  read: { pages: number; fresh: number; changed: number };
  totals: NotionReconcileSide | null;
  byStatus: Record<string, NotionReconcileSide>;
  byType: Record<string, NotionReconcileSide>;
  discrepancyCount: number;
  discrepancies: NotionReconcileDiscrepancy[];
  error: string | null;
};

export type MirrorRunReport = { databases: MirrorDatabaseReport[] };

// A report row stays small even when a sync breaks every card.
export const MAX_LISTED_DISCREPANCIES = 200;

export function runStatusOf(
  databases: readonly MirrorDatabaseReport[],
): Exclude<MirrorRunStatus, "running"> {
  if (databases.some(({ error }) => error !== null)) return "failed";
  if (databases.some(({ discrepancyCount }) => discrepancyCount > 0)) {
    return "discrepancies";
  }
  return "clean";
}

export type MirrorRunTime = {
  status: MirrorRunStatus;
  startedAt: Date;
};

export type MirrorStreak = {
  runs: number;
  since: Date | null;
  hours: number;
  brokenBy: "discrepancies" | "failed" | "gap" | null;
};

// AC-003 counts only clean runs without a gap: newest first, the streak ends
// at the first run with discrepancies or a failure, or where runs stopped for
// longer than maxGapHours (also between the newest run and now).
export function cleanStreak(
  newestFirst: readonly MirrorRunTime[],
  now: Date,
  maxGapHours: number,
): MirrorStreak {
  const maxGapMs = maxGapHours * 3_600_000;
  let runs = 0;
  let since: Date | null = null;
  let newer = now;
  let brokenBy: MirrorStreak["brokenBy"] = null;
  for (const run of newestFirst) {
    if (run.status === "running") continue;
    if (newer.getTime() - run.startedAt.getTime() > maxGapMs) {
      brokenBy = "gap";
      break;
    }
    if (run.status !== "clean") {
      brokenBy = run.status;
      break;
    }
    runs += 1;
    since = run.startedAt;
    newer = run.startedAt;
  }
  if (runs === 0 && brokenBy === "gap") since = null;
  return {
    runs,
    since,
    hours: since ? (now.getTime() - since.getTime()) / 3_600_000 : 0,
    brokenBy,
  };
}
