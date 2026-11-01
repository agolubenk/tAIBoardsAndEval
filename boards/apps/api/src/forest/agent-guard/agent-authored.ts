import { and, eq } from "drizzle-orm";
import db from "../../database";
import { agentJournalTable } from "../../database/forest-schema";

export const AGENT_CREATE_ACTION = "task.create";

// A card an agent created is the agent's finding, not the owner's statement
// (N-004): the guard journals every agent create and asks the journal back.
export async function isAgentAuthored(taskId: string) {
  const [row] = await db
    .select({ id: agentJournalTable.id })
    .from(agentJournalTable)
    .where(
      and(
        eq(agentJournalTable.targetType, "task"),
        eq(agentJournalTable.targetId, taskId),
        eq(agentJournalTable.action, AGENT_CREATE_ACTION),
        eq(agentJournalTable.actorKind, "agent"),
        eq(agentJournalTable.outcome, "allowed"),
      ),
    )
    .limit(1);
  return Boolean(row);
}
