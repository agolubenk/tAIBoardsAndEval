import { and, eq, gte, isNull } from "drizzle-orm";
import db from "../../database";
import { cardHistoryTable } from "../../database/forest-schema";

// kaneo's task routes write without an actor; once an agent's write succeeds
// the guard names it on the rows that write added (revision from the one the
// guard read). The lease keeps other agents out meanwhile; a person editing
// the same card in that instant would be named as the agent too.
export async function attributeAgentEdit(
  taskId: string,
  fromRevision: number,
  actorId: string,
) {
  await db
    .update(cardHistoryTable)
    .set({ actorId })
    .where(
      and(
        eq(cardHistoryTable.taskId, taskId),
        eq(cardHistoryTable.kind, "task"),
        isNull(cardHistoryTable.actorId),
        gte(cardHistoryTable.revision, fromRevision),
      ),
    );
}
