import { describe, expect, it, vi } from "vite-plus/test";
import { decodeWire } from "../../view/wire-format.js";
import { registerTools } from "../register.js";

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function setup(answer: unknown = { ok: true }) {
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
  const call = (name: string, args: Record<string, unknown>) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`no tool ${name}`);
    return tool.handler(args);
  };
  return { tools, client, call };
}

describe("forest tools", () => {
  it("acquires a lease for the session without leaking routing fields into the body", async () => {
    const { client, call } = setup({ fencingToken: 1 });

    const result = await call("forest_acquire_lease", {
      workspaceId: "ws 1",
      taskId: "t1",
      session: "dev-2",
      groupKey: "pair-1",
    });

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({
      fencingToken: 1,
    });
    expect(client.json).toHaveBeenCalledWith("/api/forest/ws%201/leases", {
      method: "POST",
      headers: { "x-t-boards-session": "dev-2" },
      body: JSON.stringify({ taskId: "t1", groupKey: "pair-1" }),
    });
  });

  it("requires a session label for leases", async () => {
    const { client, call } = setup();

    const result = await call("forest_acquire_lease", {
      workspaceId: "w",
      taskId: "t",
    });

    expect(result.isError).toBe(true);
    expect(client.json).not.toHaveBeenCalled();
  });

  it("sends a sector felling with sectorId", async () => {
    const { client, call } = setup();

    await call("forest_fell", {
      workspaceId: "w",
      kind: "sector",
      targetId: "sec-1",
      approvalId: "ap-1",
      reason: "Done",
    });

    expect(client.json).toHaveBeenCalledWith("/api/forest/w/fell", {
      method: "POST",
      headers: {},
      body: JSON.stringify({
        kind: "sector",
        sectorId: "sec-1",
        approvalId: "ap-1",
        reason: "Done",
      }),
    });
  });

  it("has no tool that decides an approval", () => {
    const { tools } = setup();

    expect([...tools.keys()].filter((name) => name.includes("decide"))).toEqual(
      [],
    );
  });

  it("lists logs through the view with a query string", async () => {
    const page = {
      items: [{ id: "log-1", title: "Release" }],
      nextCursor: null,
    };
    const { client, call } = setup(page);

    const result = await call("forest_list_logs", {
      workspaceId: "w",
      q: "release",
      take: 5,
    });

    expect(client.json).toHaveBeenCalledWith(
      "/api/forest/w/logs?q=release&take=5",
      {
        method: "GET",
        headers: {},
      },
    );
    expect(
      (
        decodeWire(result.content[0]?.text ?? "") as {
          data: unknown;
        }
      ).data,
    ).toEqual(page);
  });

  it("answers unchanged for a repeated read with the etag", async () => {
    const { call } = setup({ id: "log-1", title: "Release", seeds: [] });

    const first = decodeWire(
      (await call("forest_get_log", { workspaceId: "w", logId: "log-1" }))
        .content[0]?.text ?? "",
    ) as { etag: string };
    const second = await call("forest_get_log", {
      workspaceId: "w",
      logId: "log-1",
      ifNoneMatch: first.etag,
    });

    expect(decodeWire(second.content[0]?.text ?? "")).toEqual({
      unchanged: true,
      etag: first.etag,
    });
  });
});

describe("agent task writes", () => {
  it("send the lease and «да» as headers, not in the body", async () => {
    const { client, call } = setup();

    await call("update_task_status", {
      taskId: "t1",
      status: "done",
      session: "dev-1",
      fencingToken: 2,
      approvalId: "ap-1",
    });

    expect(client.json).toHaveBeenCalledWith("/api/task/status/t1", {
      method: "PUT",
      headers: {
        "x-t-boards-session": "dev-1",
        "x-t-boards-fence": "2",
        "x-t-boards-approval": "ap-1",
      },
      body: JSON.stringify({ status: "done" }),
    });
  });

  it("carry the fence on both calls of update_task", async () => {
    const { client, call } = setup({
      id: "t1",
      title: "T",
      description: "",
      status: "to-do",
      priority: "low",
      projectId: "p",
      position: 0,
    });

    await call("update_task", {
      taskId: "t1",
      status: "in-progress",
      fencingToken: 4,
    });

    expect(client.json).toHaveBeenCalledTimes(2);
    for (const [, init] of client.json.mock.calls)
      expect(init.headers).toEqual({ "x-t-boards-fence": "4" });
    expect(JSON.parse(client.json.mock.calls[1]?.[1].body)).not.toHaveProperty(
      "fencingToken",
    );
  });

  it("ask for a «да» to close a task with the exact status", async () => {
    const { client, call } = setup();

    await call("forest_request_approval", {
      workspaceId: "w",
      action: "close_task",
      targetId: "t1",
      value: "done",
      reason: "Shipped",
    });

    expect(client.json).toHaveBeenCalledWith("/api/forest/w/approvals", {
      method: "POST",
      headers: {},
      body: JSON.stringify({
        action: "close_task",
        targetId: "t1",
        value: "done",
        reason: "Shipped",
      }),
    });
  });
});

describe("view options", () => {
  it("are accepted by read tools and validated", () => {
    const { tools } = setup();
    const schema = tools.get("list_tasks")?.schema;

    expect(
      schema?.safeParse({ projectId: "p", budget: 300, fields: ["title"] })
        .success,
    ).toBe(true);
    expect(schema?.safeParse({ projectId: "p", budget: 10 }).success).toBe(
      false,
    );
  });

  it("are not forwarded to the API", async () => {
    const { client, call } = setup([]);

    await call("list_tasks", { projectId: "p", budget: 300, summary: true });

    expect(client.json).toHaveBeenCalledWith("/api/task/tasks/p", {
      method: "GET",
    });
  });

  it("are not part of write tools", () => {
    const { tools } = setup();
    const schema = tools.get("create_task")?.schema;

    expect(
      schema?.safeParse({
        projectId: "p",
        title: "T",
        description: "",
        priority: "low",
        status: "to-do",
        budget: 10,
      }).success,
    ).toBe(true);
    expect(
      schema && "shape" in schema && "budget" in (schema.shape as object),
    ).toBe(false);
  });
});
