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

// Felled cards stay on their boards in «Брёвна» and stay readable, but nothing
// is leased or written on them any more: new work grows from the log's seeds
// (owner, 01.11). Writers call this once the task row is known to exist.
export const FELLED_MESSAGE =
  "the tree was felled: its log is read-only; grow new work from its seeds";
