import { and, desc, eq, isNotNull } from "drizzle-orm";
import db from "../../database";
import { activityTable, userTable } from "../../database/schema";
import { listCardHistory } from "../history/card-history";

// kaneo keeps comments as activity rows of type "comment".
export async function loadContextComments(taskId: string, take: number) {
  const rows = await db
    .select({
      id: activityTable.id,
      authorName: userTable.name,
      content: activityTable.content,
      createdAt: activityTable.createdAt,
      updatedAt: activityTable.updatedAt,
    })
    .from(activityTable)
    .innerJoin(userTable, eq(activityTable.userId, userTable.id))
    .where(
      and(
        eq(activityTable.taskId, taskId),
        eq(activityTable.type, "comment"),
        isNotNull(activityTable.content),
      ),
    )
    .orderBy(desc(activityTable.createdAt), desc(activityTable.id))
    .limit(take);
  return rows.map((row) => ({ ...row, content: row.content ?? "" }));
}

// Which fields each edit touched, not the values: an old description is the
// largest thing on a card and belongs to the history read, not the pack.
export async function loadContextHistory(taskId: string, take: number) {
  const entries = await listCardHistory(taskId, take);
  return entries.map(({ changes, taskId: _, revision: __, ...entry }) => ({
    ...entry,
    fields: Object.keys(changes),
  }));
}
