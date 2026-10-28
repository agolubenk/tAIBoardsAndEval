import { and, asc, eq, gt } from "drizzle-orm";
import db from "../../database";
import { taskLeaseTable } from "../../database/forest-schema";
import { projectTable, taskTable } from "../../database/schema";
import { projectAccessCondition } from "../../project-access/project-access-condition";
import { PAGE_MAX } from "../read/page-cursor";

// Who works on what right now (R-026), soonest to expire first. The fencing
// token stays with its holder.
export function listLiveLeases(workspaceId: string, userId: string) {
  return db
    .select({
      taskId: taskLeaseTable.taskId,
      number: taskTable.number,
      title: taskTable.title,
      projectId: taskTable.projectId,
      projectName: projectTable.name,
      holderName: taskLeaseTable.holderName,
      holderKind: taskLeaseTable.holderKind,
      groupKey: taskLeaseTable.groupKey,
      acquiredAt: taskLeaseTable.acquiredAt,
      expiresAt: taskLeaseTable.expiresAt,
    })
    .from(taskLeaseTable)
    .innerJoin(taskTable, eq(taskLeaseTable.taskId, taskTable.id))
    .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
    .where(
      and(
        eq(projectTable.workspaceId, workspaceId),
        gt(taskLeaseTable.expiresAt, new Date()),
        projectAccessCondition(userId, projectTable.id),
      ),
    )
    .orderBy(asc(taskLeaseTable.expiresAt))
    .limit(PAGE_MAX);
}
