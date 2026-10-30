import { AGENT_ROLE_NAME } from "@kaneo/permissions";

// Roles that grant at least what the agent role grants.
const WIDER_THAN_AGENT = new Set(["owner", "admin", "member"]);

// R-010: an agent holds the narrow agent role wherever its owner can do more,
// and its owner's own role where that is narrower (a viewer or a custom role),
// so it never outranks its owner. Deleting a workspace, settings and people
// stay with people (N-004).
export function agentWorkspaceRole(ownerRole: string) {
  return ownerRole.split(",").some((name) => WIDER_THAN_AGENT.has(name))
    ? AGENT_ROLE_NAME
    : ownerRole;
}
