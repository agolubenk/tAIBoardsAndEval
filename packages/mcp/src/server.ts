import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AuthService } from "./auth/auth-service.js";
import { harnessSlug } from "./kaneo/agent-identity.js";
import { KaneoClient } from "./kaneo/client.js";
import { registerTools } from "./tools/register.js";
import { normalizeBaseUrl } from "./utils/normalize-base-url.js";

const require = createRequire(import.meta.url);
const { version: packageVersion } = require("../package.json") as {
  version: string;
};

export function createMcpServer(): McpServer {
  const baseUrl = normalizeBaseUrl(
    process.env.KANEO_API_URL || "http://localhost:1337",
  );
  const clientId = process.env.KANEO_MCP_CLIENT_ID || "kaneo-mcp";
  const apiKey = process.env.KANEO_API_KEY || undefined;
  const auth = new AuthService({ baseUrl, clientId, apiKey });
  // R-010: each session works under its own agent unless turned off.
  const agentSessions = process.env.KANEO_MCP_AGENT_SESSIONS !== "off";
  const client = new KaneoClient({ baseUrl, auth, agentSessions });
  const server = new McpServer({
    name: "kaneo-mcp",
    version: packageVersion,
  });
  const defaultHarness = () =>
    harnessSlug(process.env.KANEO_MCP_HARNESS) ??
    harnessSlug(server.server.getClientVersion()?.name) ??
    "mcp";
  registerTools(server, {
    client,
    ...(agentSessions ? { agentIdentity: { defaultHarness } } : {}),
  });
  return server;
}
