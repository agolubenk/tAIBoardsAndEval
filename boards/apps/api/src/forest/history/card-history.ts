import { and, desc, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { cardHistoryTable } from "../../database/forest-schema";

export const HISTORY_PAGE_MAX = 100;

export async function listCardHistory(taskId: string, take: number) {
  return db
    .select()
    .from(cardHistoryTable)
    .where(eq(cardHistoryTable.taskId, taskId))
    .orderBy(desc(cardHistoryTable.createdAt))
    .limit(Math.min(take, HISTORY_PAGE_MAX));
}

export async function loadHistoryEntry(taskId: string, historyId: string) {
  const [entry] = await db
    .select()
    .from(cardHistoryTable)
    .where(
      and(
        eq(cardHistoryTable.id, historyId),
        eq(cardHistoryTable.taskId, taskId),
      ),
    )
    .limit(1);
  if (!entry) {
    throw new HTTPException(404, { message: "History entry not found" });
  }
  return entry;
}
