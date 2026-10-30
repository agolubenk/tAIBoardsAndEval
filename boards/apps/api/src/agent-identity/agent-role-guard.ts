import { AGENT_ROLE_NAME } from "@kaneo/permissions";
import { APIError } from "better-auth/api";
import { eq } from "drizzle-orm";
import db, { schema } from "../database";
import { splitRoles } from "../utils/split-roles";

export const AGENT_ROLE_RESERVED =
  "The agent role belongs to agents: it cannot be given to people, edited or deleted";

function reserved() {
  return new APIError("BAD_REQUEST", {
    code: "AGENT_ROLE_RESERVED",
    message: AGENT_ROLE_RESERVED,
  });
}

// Role names are compared as better-auth stores and reads them: trimmed, and
// lowercased when a role is created.
export function namesAgentRole(role: unknown) {
  const names = Array.isArray(role)
    ? role.flatMap((name) => (typeof name === "string" ? splitRoles(name) : []))
    : typeof role === "string"
      ? splitRoles(role)
      : [];
  return names.some((name) => name.toLowerCase() === AGENT_ROLE_NAME);
}

// better-auth checks an invitation's role as sent but stores it as is, and
// roles are trimmed when read: " owner" would pass its owner check and then
// grant owner, " agent" would pass ours. Such names are refused.
export function assertPlainRoleNames(role: unknown) {
  const names = Array.isArray(role) ? role : [role];
  for (const name of names) {
    if (typeof name !== "string") continue;
    if (name.split(",").some((part) => part !== part.trim())) {
      throw new APIError("BAD_REQUEST", {
        code: "ROLE_NAME_SPACES",
        message: "Role names cannot start or end with spaces",
      });
    }
  }
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
