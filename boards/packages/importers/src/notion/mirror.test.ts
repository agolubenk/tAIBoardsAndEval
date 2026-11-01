import { describe, expect, it } from "vite-plus/test";
import type { FetchLike } from "../types.js";
import type { NotionPage } from "./api-types.js";
import { NotionClient } from "./client.js";
import { readNotionMirror } from "./mirror.js";

function json(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function page(id: string, edited: string): NotionPage {
  return {
    object: "page",
    id,
    archived: false,
    created_time: "2026-10-01T09:00:00.000Z",
    last_edited_time: edited,
    properties: {
      Name: { id: "t", type: "title", title: [{ plain_text: `Task ${id}` }] },
      Status: { id: "s", type: "status", status: { name: "Open" } },
    },
  };
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

function fakeNotion(pages: NotionPage[]) {
  const blockReads: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    const { pathname } = new URL(url);
    const method = init?.method ?? "GET";
    if (method === "GET" && pathname === "/v1/databases/db-1") {
      return json(DATABASE);
    }
    if (method === "POST" && pathname === "/v1/databases/db-1/query") {
      return json({ results: pages, has_more: false, next_cursor: null });
    }
    const block = /^\/v1\/blocks\/([^/]+)\/children$/.exec(pathname);
    if (block?.[1]) {
      blockReads.push(block[1]);
      return json({
        results: [
          {
            id: `${block[1]}-p`,
            type: "paragraph",
            has_children: false,
            paragraph: { rich_text: [{ plain_text: `Body ${block[1]}` }] },
          },
        ],
        has_more: false,
        next_cursor: null,
      });
    }
    return new Response("{}", { status: 404 });
  };
  return { client: new NotionClient({ token: "ntn_x", fetch }), blockReads };
}

describe("readNotionMirror", () => {
  it("returns raw pages and the mapped project from one read", async () => {
    const { client, blockReads } = fakeNotion([
      page("a", "2026-10-02T10:00:00.000Z"),
      page("b", "2026-10-03T10:00:00.000Z"),
    ]);

    const read = await readNotionMirror(client, "db-1", { product: "hr" });

    expect(read.database.id).toBe("db-1");
    expect(read.pages.map(({ id }) => id)).toEqual(["a", "b"]);
    expect(read.project.tasks.map(({ description }) => description)).toEqual([
      "Body a",
      "Body b",
    ]);
    expect(blockReads).toEqual(["a", "b"]);
  });

  it("reads bodies only for the pages the caller still needs", async () => {
    const { client, blockReads } = fakeNotion([
      page("a", "2026-10-02T10:00:00.000Z"),
      page("b", "2026-10-03T10:00:00.000Z"),
    ]);

    const read = await readNotionMirror(client, "db-1", {
      product: "hr",
      selectBodies: async (all) => {
        expect(all.map(({ id }) => id)).toEqual(["a", "b"]);
        return new Set(["b"]);
      },
    });

    expect(blockReads).toEqual(["b"]);
    expect(read.pages).toHaveLength(2);
    expect(read.project.tasks.map(({ description }) => description)).toEqual([
      "",
      "Body b",
    ]);
  });
});

describe("NotionClient.searchDatabases", () => {
  it("pages through search, asks for databases only and skips trashed ones", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetch: FetchLike = async (url, init) => {
      expect(new URL(url).pathname).toBe("/v1/search");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      return body.start_cursor
        ? json({
            results: [
              { id: "db-3", title: [], properties: {}, in_trash: true },
            ],
            has_more: false,
            next_cursor: null,
          })
        : json({
            results: [
              { id: "db-1", title: [], properties: {} },
              { id: "db-2", title: [], properties: {}, archived: true },
            ],
            has_more: true,
            next_cursor: "c-2",
          });
    };
    const client = new NotionClient({ token: "ntn_x", fetch });
    const found = await client.searchDatabases();
    expect(found.map((d) => d.id)).toEqual(["db-1"]);
    expect(bodies[0]).toMatchObject({
      filter: { property: "object", value: "database" },
      page_size: 100,
    });
    expect(bodies[1]).toMatchObject({ start_cursor: "c-2" });
  });
});
