import { and, desc, eq, isNull, or } from "drizzle-orm";
import db from "../../database";
import { sessionWorkStateTable } from "../../database/forest-schema";
import { projectTable, taskTable } from "../../database/schema";
import { projectAccessCondition } from "../../project-access/project-access-condition";
import { PAGE_MAX } from "../read/page-cursor";

// Latest first. A session on a card of a project the reader may not open is
// left out whole: its step usually talks about that card.
export function listWorkState(workspaceId: string, userId: string) {
  return db
    .select({
      actorName: sessionWorkStateTable.actorName,
      actorKind: sessionWorkStateTable.actorKind,
      step: sessionWorkStateTable.step,
      branch: sessionWorkStateTable.branch,
      waiting: sessionWorkStateTable.waiting,
      updatedAt: sessionWorkStateTable.updatedAt,
      taskId: sessionWorkStateTable.taskId,
      number: taskTable.number,
      title: taskTable.title,
      projectId: taskTable.projectId,
      projectName: projectTable.name,
    })
    .from(sessionWorkStateTable)
    .leftJoin(taskTable, eq(sessionWorkStateTable.taskId, taskTable.id))
    .leftJoin(projectTable, eq(taskTable.projectId, projectTable.id))
    .where(
      and(
        eq(sessionWorkStateTable.workspaceId, workspaceId),
        or(
          isNull(sessionWorkStateTable.taskId),
          projectAccessCondition(userId, projectTable.id),
        ),
      ),
    )
    .orderBy(desc(sessionWorkStateTable.updatedAt))
    .limit(PAGE_MAX);
}
