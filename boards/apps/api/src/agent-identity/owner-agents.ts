import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import db, { schema } from "../database";
import { clearMemberProjectAccess } from "../project-access/clear-member-project-access";
import { revokeUserConnections, revokeWorkspaceConnections } from "../ws";
import { syncAgent } from "./sync-agent";

function ownerAgentIds(ownerId: string, enabledOnly = false) {
  return db
    .select({ userId: schema.agentProfileTable.userId })
    .from(schema.agentProfileTable)
    .where(
      and(
        eq(schema.agentProfileTable.ownerId, ownerId),
        enabledOnly ? isNull(schema.agentProfileTable.disabledAt) : undefined,
      ),
    )
    .then((rows) => rows.map((row) => row.userId));
}

// The owner's role or project access changed: their agents follow now rather
// than at their next key. One short transaction per agent, in turn: an owner
// has few agents and role changes are rare.
export async function refreshOwnerAgents(ownerId: string) {
  for (const agentId of await ownerAgentIds(ownerId, true)) {
    await syncAgent(ownerId, agentId);
  }
}

// The owner left a workspace: their agents leave it in the same breath. The
// profile locks, taken in one order, make a mirror running right now either
// see the owner gone or be undone here.
export async function removeOwnerAgents(workspaceId: string, ownerId: string) {
  const removed = await db.transaction(async (tx) => {
    const agents = await tx
      .select({ userId: schema.agentProfileTable.userId })
      .from(schema.agentProfileTable)
      .where(eq(schema.agentProfileTable.ownerId, ownerId))
      .orderBy(asc(schema.agentProfileTable.userId))
      .for("update");
    const agentIds = agents.map((a) => a.userId);
    if (!agentIds.length) return [];
    const rows = await tx
      .delete(schema.workspaceUserTable)
      .where(
        and(
          eq(schema.workspaceUserTable.workspaceId, workspaceId),
          inArray(schema.workspaceUserTable.userId, agentIds),
        ),
      )
      .returning({ userId: schema.workspaceUserTable.userId });
    for (const { userId } of rows) {
      await clearMemberProjectAccess(workspaceId, userId, tx);
    }
    return rows.map((r) => r.userId);
  });
  for (const agentId of removed) {
    await revokeWorkspaceConnections(agentId, workspaceId, { role: "agent" });
  }
  return removed;
}

// The owner's account goes: so do the agents that acted for it. Their
// comments and cards stay, as a deleted person's do.
export async function deleteOwnerAgents(ownerId: string) {
  const agentIds = await ownerAgentIds(ownerId);
  if (!agentIds.length) return;
  await db
    .delete(schema.userTable)
    .where(
      and(
        inArray(schema.userTable.id, agentIds),
        eq(schema.userTable.role, "agent"),
      ),
    );
  await Promise.all(agentIds.map((agentId) => revokeUserConnections(agentId)));
}
