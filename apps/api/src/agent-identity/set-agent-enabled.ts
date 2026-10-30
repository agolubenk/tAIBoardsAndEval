import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db, { schema } from "../database";
import { revokeUserConnections } from "../ws";

// Disabling an agent revokes every key it holds and refuses new ones; its
// cards, comments and journal stay under its name. Enabling lets the bridge
// ask for a key again.
export async function setAgentEnabled(
  ownerId: string,
  agentId: string,
  enabled: boolean,
) {
  const result = await db.transaction(async (tx) => {
    const [profile] = await tx
      .update(schema.agentProfileTable)
      .set({ disabledAt: enabled ? null : new Date() })
      .where(
        and(
          eq(schema.agentProfileTable.userId, agentId),
          eq(schema.agentProfileTable.ownerId, ownerId),
        ),
      )
      .returning({ userId: schema.agentProfileTable.userId });
    if (!profile) {
      throw new HTTPException(404, { message: "Agent not found" });
    }
    if (enabled) return { id: agentId, enabled, revokedKeys: 0 };
    const revoked = await tx
      .delete(schema.apikeyTable)
      .where(eq(schema.apikeyTable.referenceId, agentId))
      .returning({ id: schema.apikeyTable.id });
    // Agents never sign in; a session found here was not meant to exist.
    await tx
      .delete(schema.sessionTable)
      .where(eq(schema.sessionTable.userId, agentId));
    return { id: agentId, enabled, revokedKeys: revoked.length };
  });
  if (!enabled) await revokeUserConnections(agentId);
  return result;
}
