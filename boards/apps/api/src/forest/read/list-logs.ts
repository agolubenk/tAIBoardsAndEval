import { and, desc, eq, ilike, lt, or } from "drizzle-orm";
import db from "../../database";
import { timberLogTable } from "../../database/forest-schema";
import { decodeCursor, encodeCursor, pageSize } from "./page-cursor";

function likePattern(query: string) {
  return `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

// Logs are read-only history; the list carries no history or fields, only
// what is needed to pick a log (open it with getLog).
export async function listLogs({
  workspaceId,
  query,
  cursor,
  take,
}: {
  workspaceId: string;
  query?: string;
  cursor?: string;
  take?: number;
}) {
  const limit = pageSize(take);
  const after = decodeCursor(cursor);
  const rows = await db
    .select({
      id: timberLogTable.id,
      title: timberLogTable.title,
      taskNumber: timberLogTable.taskNumber,
      finalStatus: timberLogTable.finalStatus,
      priority: timberLogTable.priority,
      sourceProjectId: timberLogTable.sourceProjectId,
      sourceProjectName: timberLogTable.sourceProjectName,
      fellingId: timberLogTable.fellingId,
      felledAt: timberLogTable.felledAt,
    })
    .from(timberLogTable)
    .where(
      and(
        eq(timberLogTable.workspaceId, workspaceId),
        query?.trim()
          ? ilike(timberLogTable.searchText, likePattern(query.trim()))
          : undefined,
        after
          ? or(
              lt(timberLogTable.felledAt, after.at),
              and(
                eq(timberLogTable.felledAt, after.at),
                lt(timberLogTable.id, after.id),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(desc(timberLogTable.felledAt), desc(timberLogTable.id))
    .limit(limit + 1);

  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > limit && last
        ? encodeCursor({ at: last.felledAt, id: last.id })
        : null,
  };
}
