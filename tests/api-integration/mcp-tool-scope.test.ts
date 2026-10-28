import { eq } from "drizzle-orm";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import db from "../../apps/api/src/database";
import {
  agentJournalTable,
  mcpToolGrantTable,
} from "../../apps/api/src/database/forest-schema";
import { createModernMcpHandler } from "../../apps/api/src/mcp/modern";
import {
  EXTRA_TOOLS_MAX,
  type McpRole,
  ROLE_TOOLS,
} from "../../apps/api/src/mcp/tool-scope/roles";
import { grantSessionKey } from "../../apps/api/src/mcp/tool-scope/tool-grants";
import { resetTestDatabase } from "./helpers/database";

const protocolVersion = "2026-07-28";

function rpc(id: number, method: string, params: Record<string, unknown> = {}) {
  const name = method === "tools/call" ? String(params.name) : undefined;
  return new Request("http://mcp.test/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: "Bearer test-token",
      "content-type": "application/json",
      "mcp-method": method,
      "mcp-protocol-version": protocolVersion,
      ...(name ? { "mcp-name": name } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": protocolVersion,
          "io.modelcontextprotocol/clientInfo": {
            name: "kaneo-tool-scope-test",
            version: "1.0.0",
          },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
}

async function send(
  token: string,
  role: McpRole | undefined,
  id: number,
  method: string,
  params?: Record<string, unknown>,
) {
  const handler = createModernMcpHandler(
    { token, userId: "user-1", role },
    "http://api.test",
  );
  const text = await (await handler.fetch(rpc(id, method, params))).text();
  const data = text
    .split("\n")
    .find((line) => line.startsWith("data: "))
    ?.slice(6);
  return JSON.parse(data ?? text).result;
}

async function listed(token: string, role?: McpRole) {
  const result = await send(token, role, 1, "tools/list");
  return (result.tools as Array<{ name: string }>).map((tool) => tool.name);
}

async function find(token: string, query: string) {
  const result = await send(token, "reader", 2, "tools/call", {
    name: "tools_find",
    arguments: { query },
  });
  return {
    isError: Boolean(result.isError),
    text: result.content[0].text as string,
  };
}

const queries = [
  "log a time entry",
  "delete a label",
  "workspace members",
  "notifications",
  "duplicate a task",
  "task relations",
];

describe("API integration: MCP tool set by role (R-034, AC-013)", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ id: "x" })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("adds at most five tools to a session that ran short, never the full set", async () => {
    const full = await listed("test-token");
    const start = await listed("test-token", "reader");
    expect(start.sort()).toEqual(
      [...ROLE_TOOLS.reader, "tools_find", "tools_call"].sort(),
    );

    let added: string[] = [];
    for (const query of queries) {
      const found = await find("test-token", query);
      if (found.isError) break;
      const body = JSON.parse(found.text);
      expect(body.added.length).toBeLessThanOrEqual(EXTRA_TOOLS_MAX);
      added = [
        ...added,
        ...body.added.map((tool: { name: string }) => tool.name),
      ];
      expect(body.left).toBe(EXTRA_TOOLS_MAX - added.length);
    }
    expect(added).toHaveLength(EXTRA_TOOLS_MAX);

    const refused = await find("test-token", "create a project");
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("Ask the owner");

    const rows = await db.select().from(mcpToolGrantTable);
    expect(rows.map((row) => row.tool).sort()).toEqual([...added].sort());
    expect(rows[0]?.sessionKey).not.toContain("test-token");

    const end = await listed("test-token", "reader");
    expect(end.sort()).toEqual(
      [...ROLE_TOOLS.reader, ...added, "tools_find", "tools_call"].sort(),
    );
    expect(end.length).toBeLessThan(full.length);

    // Another bearer is another session: it starts from the role again.
    expect((await listed("other-token", "reader")).sort()).toEqual(start);

    const journal = await db
      .select()
      .from(agentJournalTable)
      .where(eq(agentJournalTable.targetId, "tools_find"));
    expect(journal.length).toBeGreaterThan(0);
  });

  it("keeps the cap when two finds of one session race", async () => {
    const key = grantSessionKey("reader", "test-token");
    await db
      .insert(mcpToolGrantTable)
      .values(
        ["delete_label", "create_label", "move_task", "delete_task"].map(
          (tool) => ({ sessionKey: key, tool }),
        ),
      );

    // Both see the one free slot and ask for different tools at once.
    const answers = await Promise.all([
      find("test-token", "log a time entry"),
      find("test-token", "workspace members"),
    ]);

    const rows = await db
      .select()
      .from(mcpToolGrantTable)
      .where(eq(mcpToolGrantTable.sessionKey, key));
    expect(rows).toHaveLength(EXTRA_TOOLS_MAX);
    const added = answers.flatMap(
      (answer) => JSON.parse(answer.text).added as unknown[],
    );
    expect(added).toHaveLength(1);
  });
});
