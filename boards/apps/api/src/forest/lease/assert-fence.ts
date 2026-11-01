import { eq } from "drizzle-orm";
import type { Tx } from "../tx";
import { taskLeaseTable } from "../../database/forest-schema";
import { taskTable } from "../../database/schema";
import { FELLED_MESSAGE, findFelledLog } from "../find-felled-log";
import { ForestError } from "../forest-error";

export type Fence = {
  taskId: string;
  fencingToken: number;
  expectedRevision?: number;
};

// Guards a write inside the caller's transaction (I6): the lease must be live
// with exactly this token, and the task must still be at the revision read.
// Row locks keep a felling or a takeover from slipping in before the write.
export async function assertFence(tx: Tx, fence: Fence) {
  const [task] = await tx
    .select({ id: taskTable.id, revision: taskTable.revision })
    .from(taskTable)
    .where(eq(taskTable.id, fence.taskId))
    .for("update");
  if (!task) {
    if (await findFelledLog(fence.taskId, tx)) {
      throw new ForestError("felled", FELLED_MESSAGE);
    }
    throw new ForestError("lease_missing", "task not found");
  }
  if (await findFelledLog(fence.taskId, tx)) {
    throw new ForestError("felled", FELLED_MESSAGE);
  }

  const [lease] = await tx
    .select()
    .from(taskLeaseTable)
    .where(eq(taskLeaseTable.taskId, fence.taskId))
    .for("update");
  if (!lease) throw new ForestError("lease_missing", "acquire a lease first");
  if (
    lease.fencingToken !== fence.fencingToken ||
    lease.expiresAt.getTime() <= Date.now()
  ) {
    throw new ForestError(
      "lease_stale",
      `token ${fence.fencingToken} is no longer current (held by ${lease.holderName})`,
    );
  }
  if (
    fence.expectedRevision !== undefined &&
    task.revision !== fence.expectedRevision
  ) {
    throw new ForestError(
      "revision_conflict",
      `task is at revision ${task.revision}, not ${fence.expectedRevision}`,
    );
  }
  return { lease, revision: task.revision };
}
