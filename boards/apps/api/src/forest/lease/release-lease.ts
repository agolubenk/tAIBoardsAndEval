import { and, eq } from "drizzle-orm";
import db from "../../database";
import { taskLeaseTable } from "../../database/forest-schema";

// Ends the lease early but keeps the row, so the next token is still higher.
// Releasing with a stale token is a no-op: it cannot end someone else's lease.
export async function releaseLease(taskId: string, fencingToken: number) {
  const released = await db
    .update(taskLeaseTable)
    .set({ expiresAt: new Date() })
    .where(
      and(
        eq(taskLeaseTable.taskId, taskId),
        eq(taskLeaseTable.fencingToken, fencingToken),
      ),
    )
    .returning({ taskId: taskLeaseTable.taskId });
  return { released: released.length > 0 };
}
