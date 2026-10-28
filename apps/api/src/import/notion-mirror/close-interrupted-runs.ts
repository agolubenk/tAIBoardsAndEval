import { and, eq } from "drizzle-orm";
import db from "../../database";
import { notionMirrorRunTable } from "../../database/forest-schema";
import { failedReport } from "./mirror-report";

export const INTERRUPTED_RUN_ERROR =
  "The run stopped before it finished: the API restarted or crashed";

// Runs open only under the mirror lease, so none is alive while a new one
// opens: a `running` row left behind is a run a restart cut short. Closing it
// as failed keeps the list honest and lets the streak count the gap.
export async function closeInterruptedRuns(
  workspaceId: string,
  now = new Date(),
): Promise<number> {
  const closed = await db
    .update(notionMirrorRunTable)
    .set({
      status: "failed",
      report: {
        databases: [failedReport("(interrupted)", INTERRUPTED_RUN_ERROR)],
      },
      finishedAt: now,
    })
    .where(
      and(
        eq(notionMirrorRunTable.workspaceId, workspaceId),
        eq(notionMirrorRunTable.status, "running"),
      ),
    )
    .returning({ id: notionMirrorRunTable.id });
  return closed.length;
}
