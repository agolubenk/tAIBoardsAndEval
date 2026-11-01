import {
  EXTRA_TOOLS_MAX,
  MCP_ROLES,
  ROLE_HEADER,
  ROLE_TOOLS,
} from "../mcp/tool-scope/roles";

// R-034 as the settings page shows it: what a session of each role sees.
export function toolSets() {
  return {
    header: ROLE_HEADER,
    extraMax: EXTRA_TOOLS_MAX,
    roles: MCP_ROLES.map((role) => ({ role, tools: [...ROLE_TOOLS[role]] })),
  };
}
