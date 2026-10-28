import { describe, expect, it } from "vite-plus/test";
import type { FetchLike } from "../types.js";
import type { NotionBlock, NotionPage } from "./api-types.js";
import { NOTION_VERSION } from "./client.js";
import { connectNotion } from "./source.js";

const TOKEN = "ntn_secret";

type Call = { method: string; path: string; body: unknown; headers: Headers };

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function list<T>(results: T[], next: string | null) {
  return { results, has_more: next !== null, next_cursor: next };
}

function paragraph(
  id: string,
  text: string,
  has_children = false,
): NotionBlock {
  return {
    id,
    type: "paragraph",
    has_children,
    paragraph: { rich_text: [{ plain_text: text }] },
  };
}

function page(id: string): NotionPage {
  return {
    object: "page",
    id,
    archived: false,
    created_time: "2026-10-01T09:00:00.000Z",
    last_edited_time: "2026-10-02T10:00:00.000Z",
    properties: {
      Name: { id: "t", type: "title", title: [{ plain_text: `Task ${id}` }] },
      Status: { id: "s", type: "status", status: { name: "Open" } },
    },
  };
}

function fakeNotion(routes: Record<string, (call: Call) => unknown>) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const { pathname, search } = new URL(url);
    const call: Call = {
      method: init?.method ?? "GET",
      path: `${pathname}${search}`,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: new Headers(init?.headers),
    };
    calls.push(call);
    const route = routes[`${call.method} ${pathname}`];
    if (!route)
      return json({ message: `unexpected ${call.method} ${pathname}` }, 404);
    return json(route(call));
  };
  return { fetch, calls };
}

const DATABASE = {
  id: "db-1",
  title: [{ plain_text: "Tasks" }],
  properties: {
    Name: { id: "t", name: "Name", type: "title" },
    Status: {
      id: "s",
      name: "Status",
      type: "status",
      status: { options: [{ id: "o1", name: "Open" }], groups: [] },
    },
  },
};

function workspace() {
  return fakeNotion({
    "GET /v1/users/me": () => ({ object: "user", id: "bot" }),
    "GET /v1/databases/db-1": () => DATABASE,
    "POST /v1/databases/db-1/query": (call) => {
      const cursor = (call.body as { start_cursor?: string }).start_cursor;
      return cursor === "c2"
        ? list([page("p-2")], null)
        : list([page("p-1")], "c2");
    },
    "GET /v1/blocks/p-1/children": (call) =>
      call.path.includes("start_cursor=b2")
        ? list([paragraph("b-2", "Second", true)], null)
        : list([paragraph("b-1", "First")], "b2"),
    "GET /v1/blocks/b-2/children": () =>
      list([paragraph("b-3", "Nested")], null),
    "GET /v1/blocks/p-2/children": () => list([], null),
  });
}

describe("connectNotion", () => {
  it("rejects a missing token or database list before calling Notion", async () => {
    const { fetch, calls } = workspace();
    await expect(
      connectNotion({ token: " ", databaseIds: ["db-1"] }, { fetch }),
    ).rejects.toThrow(/integration token/);
    await expect(
      connectNotion({ token: TOKEN, databaseIds: [" "] }, { fetch }),
    ).rejects.toThrow(/database ID/);
    expect(calls).toEqual([]);
  });

  it("checks the token and lists one project per database", async () => {
    const { fetch, calls } = workspace();
    const source = await connectNotion(
      { token: TOKEN, databaseIds: ["db-1", "db-1"] },
      { fetch },
    );

    expect(await source.listProjects()).toEqual([
      { id: "db-1", name: "Tasks", detail: "2 fields" },
    ]);
    expect(calls[0]?.path).toBe("/v1/users/me");
    expect(calls[0]?.headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]?.headers.get("Notion-Version")).toBe(NOTION_VERSION);
  });

  it("pages through the database and every block level", async () => {
    const { fetch, calls } = workspace();
    const source = await connectNotion(
      { token: TOKEN, databaseIds: ["db-1"], product: "hr" },
      { fetch },
    );

    const project = await source.readProject("db-1", { includeComments: true });

    const queries = calls.filter((call) => call.path.endsWith("/query"));
    expect(queries.map((call) => call.body)).toEqual([
      {
        page_size: 100,
        sorts: [{ timestamp: "last_edited_time", direction: "ascending" }],
      },
      {
        page_size: 100,
        start_cursor: "c2",
        sorts: [{ timestamp: "last_edited_time", direction: "ascending" }],
      },
    ]);
    expect(project.tasks.map((task) => task.key)).toEqual([
      "hr:notion:p-1",
      "hr:notion:p-2",
    ]);
    expect(project.tasks[0]?.description).toBe("First\n\nSecond\n\nNested");
    expect(project.tasks[1]?.description).toBe("");
    expect(calls.every((call) => !call.path.includes(TOKEN))).toBe(true);
  });

  it("reports an unshared database as a 401 hint without echoing the token", async () => {
    const fetch: FetchLike = async () => json({ message: "unauthorized" }, 401);
    const error = await connectNotion(
      { token: TOKEN, databaseIds: ["db-1"] },
      { fetch },
    ).catch((caught: unknown) => caught);
    expect(String(error)).toMatch(/shared with the databases/);
    expect(String(error)).not.toContain(TOKEN);
  });
});
