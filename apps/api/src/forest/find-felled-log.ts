import { and, eq, sql } from "drizzle-orm";
import db from "../database";
import { timberLogTable } from "../database/forest-schema";

type Reader = Pick<typeof db, "select">;

// Which log, if any, swallowed this task — root or branch alike.
export async function findFelledLog(
  taskId: string,
  reader: Reader = db,
  workspaceId?: string,
) {
  const [log] = await reader
    .select({ id: timberLogTable.id, fellingId: timberLogTable.fellingId })
    .from(timberLogTable)
    .where(
      and(
        sql`${timberLogTable.felledTaskIds} @> ${JSON.stringify([taskId])}::jsonb`,
        workspaceId ? eq(timberLogTable.workspaceId, workspaceId) : undefined,
      ),
    )
    .limit(1);
  return log ?? null;
}
