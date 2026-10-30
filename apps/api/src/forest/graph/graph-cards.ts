import { and, desc, eq, type SQLWrapper, sql } from "drizzle-orm";
import db from "../../database";
import { cardMetaTable } from "../../database/forest-schema";
import { projectTable, taskTable } from "../../database/schema";
import { projectAccessCondition } from "../../project-access/project-access-condition";
import { taskIsCompleted } from "../../task/task-is-completed";
import type { PageCursor } from "../read/page-cursor";

// The cursor carries milliseconds, the column microseconds: page on the
// truncated value, or a card created in the same millisecond is skipped.
export const createdMs = (createdAt: SQLWrapper) =>
  sql`date_trunc('milliseconds', ${createdAt})`;

// A timestamp column holds UTC wall time; the ISO string casts to exactly that.
export const cursorRow = (after: PageCursor) =>
  sql`(${after.at.toISOString()}::timestamp, ${after.id})`;

// Cards of the workspace the reader may open, newest first.
export function graphCards({
  workspaceId,
  userId,
  after,
  limit,
}: {
  workspaceId: string;
  userId: string;
  after: PageCursor | null;
  limit: number;
}) {
  return db
    .select({
      id: taskTable.id,
      number: taskTable.number,
      title: taskTable.title,
      status: taskTable.status,
      isCompleted: taskIsCompleted,
      isBug: sql<boolean>`coalesce(${cardMetaTable.kind} = 'bug', false)`,
      projectId: projectTable.id,
      projectName: projectTable.name,
      createdAt: taskTable.createdAt,
    })
    .from(taskTable)
    .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
    .leftJoin(cardMetaTable, eq(cardMetaTable.taskId, taskTable.id))
    .where(
      and(
        eq(projectTable.workspaceId, workspaceId),
        projectAccessCondition(userId, projectTable.id),
        after
          ? sql`(${createdMs(taskTable.createdAt)}, ${taskTable.id}) < ${cursorRow(after)}`
          : undefined,
      ),
    )
    .orderBy(desc(createdMs(taskTable.createdAt)), desc(taskTable.id))
    .limit(limit);
}
