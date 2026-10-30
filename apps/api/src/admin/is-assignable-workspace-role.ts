import { AGENT_ROLE_NAME, DEFAULT_ROLE_NAMES } from "@kaneo/permissions";
import { and, eq } from "drizzle-orm";
import { schema } from "../database";
import type { DbOrTx } from "../project-access/db-or-tx";

export async function isAssignableWorkspaceRole(
  database: DbOrTx,
  workspaceId: string,
  role: string,
): Promise<boolean> {
  // The agent role is held by agents only (R-010).
  if (role.includes(",") || role === "owner" || role === AGENT_ROLE_NAME)
    return false;
  if ((DEFAULT_ROLE_NAMES as readonly string[]).includes(role)) return true;

  const [custom] = await database
    .select({ id: schema.workspaceRoleTable.id })
    .from(schema.workspaceRoleTable)
    .where(
      and(
        eq(schema.workspaceRoleTable.workspaceId, workspaceId),
        eq(schema.workspaceRoleTable.role, role),
      ),
    )
    .limit(1);
  return Boolean(custom);
}
