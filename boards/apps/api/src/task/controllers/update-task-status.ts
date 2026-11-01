import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { withLockedTask } from "./with-locked-task";
import { columnTable, taskTable } from "../../database/schema";
import { publishEvent } from "../../events";
import { publishTaskMutation } from "./task-mutation-effects";
import { assertValidTaskStatus } from "../validate-task-fields";

async function updateTaskStatus({
  id,
  status,
  currentUserId,
}: {
  id: string;
  status: string;
  currentUserId: string;
}) {
  const { before: existingTask, after: updatedTask } = await withLockedTask(
    id,
    async (tx, existingTask) => {
      await assertValidTaskStatus(status, existingTask.projectId, tx);

      const column = await tx.query.columnTable.findFirst({
        where: and(
          eq(columnTable.projectId, existingTask.projectId),
          eq(columnTable.slug, status),
        ),
      });

      // Brevna guards (spec R-007, D-011): the closed column is a timber
      // yard — a card enters it only from done, and never leaves it.
      if (status === "closed" && existingTask.status !== "closed") {
        if (existingTask.status !== "done") {
          throw new HTTPException(409, {
            message: "Брёвна принимают только из Done",
          });
        }
      }
      if (existingTask.status === "closed" && status !== "closed") {
        throw new HTTPException(409, {
          message: "Карточка в Брёвнах — терминальный статус",
        });
      }

      const [updatedTask] = await tx
        .update(taskTable)
        .set({ status, columnId: column?.id ?? null })
        .where(eq(taskTable.id, id))
        .returning();

      if (!updatedTask) {
        throw new HTTPException(500, {
          message: "Failed to update task status",
        });
      }

      return updatedTask;
    },
  );

  await publishTaskMutation(existingTask, updatedTask, currentUserId, {
    fields: ["status"],
  });

  if (
    existingTask.status === updatedTask.status &&
    existingTask.columnId !== updatedTask.columnId
  )
    await publishEvent("task.updated", {
      taskId: updatedTask.id,
      projectId: updatedTask.projectId,
      userId: currentUserId,
    });

  return updatedTask;
}

export default updateTaskStatus;
