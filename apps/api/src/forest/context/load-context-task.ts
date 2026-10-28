import { and, asc, eq, isNull } from "drizzle-orm";
import db from "../../database";
import {
  labelTable,
  projectTable,
  taskTable,
  userTable,
} from "../../database/schema";
import { taskIsCompleted } from "../../task/task-is-completed";

const LABELS_MAX = 50;

// The card itself; the caller has already resolved it in the workspace.
export async function loadContextTask(taskId: string) {
  const [[task], labels] = await Promise.all([
    db
      .select({
        id: taskTable.id,
        number: taskTable.number,
        title: taskTable.title,
        status: taskTable.status,
        isCompleted: taskIsCompleted,
        priority: taskTable.priority,
        assigneeName: userTable.name,
        projectId: taskTable.projectId,
        projectName: projectTable.name,
        revision: taskTable.revision,
        startDate: taskTable.startDate,
        dueDate: taskTable.dueDate,
        createdAt: taskTable.createdAt,
        updatedAt: taskTable.updatedAt,
        description: taskTable.description,
      })
      .from(taskTable)
      .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
      .leftJoin(userTable, eq(taskTable.userId, userTable.id))
      .where(eq(taskTable.id, taskId))
      .limit(1),
    db
      .select({ name: labelTable.name })
      .from(labelTable)
      .where(
        and(
          eq(labelTable.taskId, taskId),
          isNull(labelTable.deletionStartedAt),
        ),
      )
      .orderBy(asc(labelTable.name))
      .limit(LABELS_MAX),
  ]);
  return task ? { ...task, labels: labels.map((label) => label.name) } : null;
}
