import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../database";
import { projectTable, taskTable } from "../database/schema";
import { assertProjectAccess } from "../project-access/assert-project-access";
import { findFelledLog } from "./find-felled-log";
import { ForestError } from "./forest-error";

type Reader = Pick<typeof db, "select">;

// Resolves a task inside the route's workspace and checks project access.
// A felled id answers «felled» instead of 404, so stale agents learn why.
export async function assertTaskInWorkspace(
  taskId: string,
  workspaceId: string,
  userId: string,
  reader: Reader = db,
) {
  const [task] = await reader
    .select({
      projectId: taskTable.projectId,
      workspaceId: projectTable.workspaceId,
    })
    .from(taskTable)
    .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
    .where(eq(taskTable.id, taskId))
    .limit(1);
  if (!task) {
    if (await findFelledLog(taskId, reader, workspaceId)) {
      throw new ForestError("felled", "the tree was felled; logs do not grow");
    }
    throw new HTTPException(404, { message: "Task not found" });
  }
  if (task.workspaceId !== workspaceId) {
    throw new HTTPException(404, { message: "Task not found" });
  }
  await assertProjectAccess(userId, task.projectId);
  return task;
}
