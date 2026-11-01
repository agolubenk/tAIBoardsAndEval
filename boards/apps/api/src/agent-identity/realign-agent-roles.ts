import { AGENT_ROLE_NAME } from "@kaneo/permissions";
import { eq, inArray } from "drizzle-orm";
import db, { schema } from "../database";
import { agentWorkspaceRole } from "./agent-workspace-role";

// Agents issued before the agent role hold their owner's role, an admin's at
// most. At startup they move to the agent role instead of waiting for their
// next key; a viewer's or a custom role stays. Runs after the role seed, so
// the role exists in every workspace.
export async function realignAgentRoles() {
  const rows = await db
    .select({
      id: schema.workspaceUserTable.id,
      role: schema.workspaceUserTable.role,
    })
    .from(schema.workspaceUserTable)
    .innerJoin(
      schema.userTable,
      eq(schema.userTable.id, schema.workspaceUserTable.userId),
    )
    .where(eq(schema.userTable.role, "agent"));
  const stale = rows
    .filter((row) => agentWorkspaceRole(row.role) !== row.role)
    .map((row) => row.id);
  if (stale.length === 0) return 0;
  await db
    .update(schema.workspaceUserTable)
    .set({ role: AGENT_ROLE_NAME })
    .where(inArray(schema.workspaceUserTable.id, stale));
  console.log(
    `✅ Moved ${stale.length} agent membership(s) to the agent role.`,
  );
  return stale.length;
}
