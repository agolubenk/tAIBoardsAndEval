import { describe, expect, it, vi } from "vite-plus/test";
import { registerTools } from "./register.js";

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function setup(answer: unknown) {
  const tools = new Map<
    string,
    {
      schema: { safeParse: (v: unknown) => { success: boolean } };
      handler: Handler;
    }
  >();
  const server = {
    registerTool: vi.fn(
      (name: string, config: { inputSchema: never }, handler: Handler) => {
        tools.set(name, { schema: config.inputSchema, handler });
      },
    ),
  };
  const client = { json: vi.fn().mockResolvedValue(answer) };
  registerTools(server as never, { client: client as never });
  const tool = tools.get("notebook_search");
  if (!tool) throw new Error("notebook_search is not registered");
  return { tool, client };
}

const hits = {
  mode: "keyword",
  results: [
    {
      chunkId: "c1",
      source: { kind: "card", ref: "t1", title: "AIB-12 Блокнот в UI" },
      heading: "AIB-12 Блокнот в UI",
      text: "Страница с чатом.",
      score: 0.016,
      matchedBy: ["keyword"],
    },
  ],
};

describe("notebook_search", () => {
  it("posts the query to the workspace notebook and returns the hits", async () => {
    const { tool, client } = setup(hits);

    const result = await tool.handler({
      workspaceId: "ws 1",
      query: "блокнот",
      limit: 3,
    });

    expect(result.isError).toBe(false);
    expect(client.json).toHaveBeenCalledWith("/api/notebook/ws%201/search", {
      method: "POST",
      body: JSON.stringify({ query: "блокнот", limit: 3 }),
    });
    expect(result.content[0]?.text).toContain("Страница с чатом.");
  });

  it("rejects an empty query and an oversized limit", () => {
    const { tool } = setup(hits);

    expect(
      tool.schema.safeParse({ workspaceId: "ws", query: "  " }).success,
    ).toBe(false);
    expect(
      tool.schema.safeParse({ workspaceId: "ws", query: "q", limit: 21 })
        .success,
    ).toBe(false);
    expect(
      tool.schema.safeParse({ workspaceId: "ws", query: "q", mode: "keyword" })
        .success,
    ).toBe(true);
  });
});
