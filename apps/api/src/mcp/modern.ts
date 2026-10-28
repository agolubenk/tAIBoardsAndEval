import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { type McpSession, registerMcpTools, toMcpToolRegistrar } from "./tools";

/** Create a stateless MCP 2026 handler with a fresh server per request. */
export function createModernMcpHandler(session: McpSession, apiUrl: string) {
  return createMcpHandler(
    async () => {
      const server = new McpServer({
        name: "kaneo-mcp",
        version: "1.0.0",
      });
      await registerMcpTools(toMcpToolRegistrar(server), apiUrl, session);
      return server;
    },
    { legacy: "reject" },
  );
}
