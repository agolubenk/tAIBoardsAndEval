import { and, desc, eq, ne } from "drizzle-orm";
import db from "../../database";
import { notionMirrorRunTable } from "../../database/forest-schema";
import { maxGapHours, readMirrorConfig } from "./mirror-config";
import { cleanStreak } from "./mirror-report";

// A streak over the whole transition window at two-hourly runs, plus manual
// ones; the list itself shows the last day.
const STREAK_RUNS = 100;
const LISTED_RUNS = 12;

// Summaries only: a report can list hundreds of discrepancies, so just the
// newest finished run carries its report.
export async function listMirrorRuns(workspaceId: string, now = new Date()) {
  const config = readMirrorConfig();
  const configured = config?.workspaceId === workspaceId;
  const runs = await db
    .select({
      id: notionMirrorRunTable.id,
      trigger: notionMirrorRunTable.trigger,
      status: notionMirrorRunTable.status,
      discrepancyCount: notionMirrorRunTable.discrepancyCount,
      startedAt: notionMirrorRunTable.startedAt,
      finishedAt: notionMirrorRunTable.finishedAt,
    })
    .from(notionMirrorRunTable)
    .where(eq(notionMirrorRunTable.workspaceId, workspaceId))
    .orderBy(desc(notionMirrorRunTable.startedAt))
    .limit(STREAK_RUNS);
  const [latest] = await db
    .select({
      id: notionMirrorRunTable.id,
      report: notionMirrorRunTable.report,
    })
    .from(notionMirrorRunTable)
    .where(
      and(
        eq(notionMirrorRunTable.workspaceId, workspaceId),
        ne(notionMirrorRunTable.status, "running"),
      ),
    )
    .orderBy(desc(notionMirrorRunTable.startedAt))
    .limit(1);

  const gap = maxGapHours();
  return {
    configured,
    cron: configured ? (config?.cron ?? null) : null,
    maxGapHours: gap,
    streak: cleanStreak(runs, now, gap),
    runs: runs.slice(0, LISTED_RUNS),
    latest: latest ?? null,
  };
}
