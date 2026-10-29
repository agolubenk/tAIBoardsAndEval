import { and, eq, lt } from "drizzle-orm";
import db from "../../database";
import { sessionWorkStateTable } from "../../database/forest-schema";
import type { ForestActor } from "../actor";

// A session nobody updated for a month is gone; the next write in the
// workspace clears it, so the list never needs a cleanup job.
export const WORK_STATE_TTL_DAYS = 30;

export type WorkStateInput = {
  taskId: string | null;
  step: string;
  branch: string | null;
  waiting: string | null;
};

export async function setWorkState(
  workspaceId: string,
  actor: ForestActor,
  input: WorkStateInput,
) {
  const now = new Date();
  const row = {
    workspaceId,
    actorId: actor.id,
    actorName: actor.name,
    actorKind: actor.kind,
    ...input,
    updatedAt: now,
  };
  const [saved] = await db
    .insert(sessionWorkStateTable)
    .values(row)
    .onConflictDoUpdate({
      target: [
        sessionWorkStateTable.workspaceId,
        sessionWorkStateTable.actorId,
      ],
      set: {
        actorName: row.actorName,
        taskId: row.taskId,
        step: row.step,
        branch: row.branch,
        waiting: row.waiting,
        updatedAt: now,
      },
    })
    .returning({
      taskId: sessionWorkStateTable.taskId,
      step: sessionWorkStateTable.step,
      branch: sessionWorkStateTable.branch,
      waiting: sessionWorkStateTable.waiting,
      updatedAt: sessionWorkStateTable.updatedAt,
    });
  await db
    .delete(sessionWorkStateTable)
    .where(
      and(
        eq(sessionWorkStateTable.workspaceId, workspaceId),
        lt(
          sessionWorkStateTable.updatedAt,
          new Date(now.getTime() - WORK_STATE_TTL_DAYS * 86_400_000),
        ),
      ),
    );
  return saved;
}

export async function clearWorkState(workspaceId: string, actor: ForestActor) {
  const removed = await db
    .delete(sessionWorkStateTable)
    .where(
      and(
        eq(sessionWorkStateTable.workspaceId, workspaceId),
        eq(sessionWorkStateTable.actorId, actor.id),
      ),
    )
    .returning({ actorId: sessionWorkStateTable.actorId });
  return { removed: removed.length > 0 };
}
