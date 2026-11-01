import { eq } from "drizzle-orm";
import db, { schema } from "../database";
import { handleMemberAdded } from "../workspace-members/handle-member-added";
import { revokeWorkspaceConnections } from "../ws";
import { mirrorMemberships } from "./mirror-memberships";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type SyncOutcome = "synced" | "disabled" | "missing";

// Brings one agent in line with its owner under the agent's profile lock, so
// bridges issuing at once, owner changes and removals never interleave.
// `inLock` runs in the same transaction after the mirror.
export async function syncAgent(
  ownerId: string,
  agentId: string,
  inLock?: (tx: Tx) => Promise<void>,
): Promise<SyncOutcome> {
  const result = await db.transaction(async (tx) => {
    const [profile] = await tx
      .select({ disabledAt: schema.agentProfileTable.disabledAt })
      .from(schema.agentProfileTable)
      .where(eq(schema.agentProfileTable.userId, agentId))
      .for("update");
    if (!profile) return { outcome: "missing" as const };
    if (profile.disabledAt) return { outcome: "disabled" as const };
    const changes = await mirrorMemberships(tx, ownerId, agentId);
    await inLock?.(tx);
    return { outcome: "synced" as const, ...changes };
  });
  if (result.outcome !== "synced") return result.outcome;
  for (const workspaceId of result.joined) {
    await handleMemberAdded(workspaceId, agentId);
  }
  for (const workspaceId of result.left) {
    await revokeWorkspaceConnections(agentId, workspaceId, { role: "agent" });
  }
  return "synced";
}
