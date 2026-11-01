import { and, asc, desc, eq } from "drizzle-orm";
import db from "../../database";
import {
  notebookMessageTable,
  notebookThreadTable,
} from "../../database/notebook-schema";
import { findThread } from "./ask-notebook";

export const THREADS_MAX = 100;
export const THREAD_MESSAGES_MAX = 200;

export async function listThreads(workspaceId: string) {
  return db
    .select()
    .from(notebookThreadTable)
    .where(eq(notebookThreadTable.workspaceId, workspaceId))
    .orderBy(desc(notebookThreadTable.updatedAt))
    .limit(THREADS_MAX);
}

export async function readThread(workspaceId: string, threadId: string) {
  const thread = await findThread(workspaceId, threadId);
  const messages = await db
    .select()
    .from(notebookMessageTable)
    .where(eq(notebookMessageTable.threadId, thread.id))
    // A question and its answer can share a timestamp: the question first.
    .orderBy(
      asc(notebookMessageTable.createdAt),
      desc(notebookMessageTable.role),
    )
    .limit(THREAD_MESSAGES_MAX);
  return { thread, messages };
}

export async function deleteThread(workspaceId: string, threadId: string) {
  const deleted = await db
    .delete(notebookThreadTable)
    .where(
      and(
        eq(notebookThreadTable.id, threadId),
        eq(notebookThreadTable.workspaceId, workspaceId),
      ),
    )
    .returning({ id: notebookThreadTable.id });
  return deleted.length > 0;
}
