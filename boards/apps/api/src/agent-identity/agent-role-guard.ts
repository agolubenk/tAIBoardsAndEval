import { AGENT_ROLE_NAME } from "@kaneo/permissions";
import { APIError } from "better-auth/api";
import { eq } from "drizzle-orm";
import db, { schema } from "../database";

export const AGENT_ROLE_RESERVED =
  "The agent role belongs to agents: it cannot be given to people, edited or deleted";

function reserved() {
  return new APIError("BAD_REQUEST", {
    code: "AGENT_ROLE_RESERVED",
    message: AGENT_ROLE_RESERVED,
  });
}

export function namesAgentRole(role: unknown) {
  const names = Array.isArray(role)
    ? role
    : typeof role === "string"
      ? role.split(",")
      : [];
  return names.includes(AGENT_ROLE_NAME);
}

// R-010: a person never holds the agent role; agents get it from their owner.
export function assertNotAgentRole(role: unknown) {
  if (namesAgentRole(role)) throw reserved();
}

type RoleRequest = {
  role?: unknown;
  roleName?: unknown;
  roleId?: unknown;
  data?: { roleName?: unknown };
};

// The agent role keeps every agent narrower than its owner, so the role
// endpoints can neither change nor remove it, nor make another one by its name.
export async function assertAgentRoleUntouched(body: RoleRequest | undefined) {
  if (
    namesAgentRole(body?.role) ||
    namesAgentRole(body?.roleName) ||
    namesAgentRole(body?.data?.roleName)
  ) {
    throw reserved();
  }
  if (typeof body?.roleId !== "string") return;
  const [row] = await db
    .select({ role: schema.workspaceRoleTable.role })
    .from(schema.workspaceRoleTable)
    .where(eq(schema.workspaceRoleTable.id, body.roleId))
    .limit(1);
  if (row && namesAgentRole(row.role)) throw reserved();
}
