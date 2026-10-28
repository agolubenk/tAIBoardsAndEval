import {
  createRegisterTool,
  registerTools,
  type ToolClient,
  type ToolRegistrar,
} from "@kaneo/mcp/tools";
import { describe, expect, it, vi } from "vite-plus/test";
import { EXTRA_TOOLS_MAX, MCP_ROLES, ROLE_TOOLS } from "./roles";
import { collectTools, registerScoped, type ToolScope } from "./scoped-tools";

const client: ToolClient = { json: async <T>() => ({ id: "t1" }) as T };

function served() {
  const tools = new Map<string, (args: unknown) => Promise<unknown>>();
  const server: ToolRegistrar = {
    registerTool: (name, _config, callback) => tools.set(name, callback),
  };
  return { server, tools };
}

function setup(scope: Partial<ToolScope> = {}) {
  const catalog = collectTools((registrar) =>
    registerTools(registrar, { client }),
  );
  const { server, tools } = served();
  const held: string[] = [...(scope.granted ?? [])];
  const grant = vi.fn(async (picked: string[]) => {
    for (const name of picked)
      if (held.length < EXTRA_TOOLS_MAX && !held.includes(name))
        held.push(name);
    return [...held];
  });
  registerScoped(server, createRegisterTool(server, client), catalog, {
    role: "developer",
    granted: [],
    grant,
    ...scope,
  });
  return { catalog, tools, grant };
}

async function call(
  tools: Map<string, (args: unknown) => Promise<unknown>>,
  name: string,
  args: unknown,
) {
  const result = (await tools.get(name)?.(args)) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
  return {
    isError: Boolean(result.isError),
    text: result.content[0]?.text ?? "",
  };
}

describe("registerScoped", () => {
  it("names only tools the package registers in every role", () => {
    const catalog = collectTools((registrar) =>
      registerTools(registrar, { client }),
    );
    for (const role of MCP_ROLES)
      for (const name of ROLE_TOOLS[role])
        expect(catalog.has(name), `${role}: ${name}`).toBe(true);
  });

  it("serves the role's tools, the granted ones and the two meta tools", () => {
    const { catalog, tools } = setup({ granted: ["create_time_entry"] });

    expect([...tools.keys()].sort()).toEqual(
      [
        ...ROLE_TOOLS.developer,
        "create_time_entry",
        "tools_find",
        "tools_call",
      ].sort(),
    );
    expect(tools.size).toBeLessThan(catalog.size);
  });

  it("adds the nearest missing tools and answers with their schemas", async () => {
    const { tools, grant } = setup();

    const found = await call(tools, "tools_find", { query: "log time entry" });
    const body = JSON.parse(found.text);

    expect(found.isError).toBe(false);
    expect(body.added.length).toBeGreaterThan(0);
    expect(body.added.length).toBeLessThanOrEqual(EXTRA_TOOLS_MAX);
    expect(body.added.map((tool: { name: string }) => tool.name)).toContain(
      "create_time_entry",
    );
    expect(body.added[0].inputSchema.type).toBe("object");
    expect(grant).toHaveBeenCalledOnce();
    for (const tool of body.added)
      expect(ROLE_TOOLS.developer).not.toContain(tool.name);
  });

  it("adds at most three tools per find, leaving the rest for the next", async () => {
    const { tools } = setup();

    const body = JSON.parse(
      (await call(tools, "tools_find", { query: "time entry" })).text,
    );

    expect(body.added).toHaveLength(3);
    expect(body.left).toBe(EXTRA_TOOLS_MAX - 3);
  });

  it("refuses a find once the session took its five tools", async () => {
    const { tools, grant } = setup({
      granted: [
        "delete_label",
        "create_label",
        "move_task",
        "delete_task",
        "create_time_entry",
      ],
    });

    const found = await call(tools, "tools_find", {
      query: "workspace members",
    });

    expect(found.isError).toBe(true);
    expect(found.text).toContain("Ask the owner");
    expect(grant).not.toHaveBeenCalled();
  });

  it("calls a granted tool through tools_call and refuses one it does not hold", async () => {
    const { tools } = setup({ granted: ["get_time_entry"] });

    const held = await call(tools, "tools_call", {
      name: "get_time_entry",
      arguments: { id: "e1" },
    });
    const missing = await call(tools, "tools_call", {
      name: "delete_task",
      arguments: { taskId: "t1" },
    });

    expect(held.isError).toBe(false);
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("tools_find");
  });
});
