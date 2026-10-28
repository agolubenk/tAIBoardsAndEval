import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FetchLike, NotionPage } from "@kaneo/importers";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import {
  cardMetaTable,
  notionMirrorRunTable,
} from "../../apps/api/src/database/forest-schema";
import { listMirrorRuns } from "../../apps/api/src/import/notion-mirror/list-mirror-runs";
import type { NotionMirrorConfig } from "../../apps/api/src/import/notion-mirror/mirror-config";
import { mirrorOnce } from "../../apps/api/src/import/notion-mirror/run-notion-mirror";
import { resetTestDatabase } from "./helpers/database";
import { createWorkspaceMember } from "./helpers/fixtures";

const TOKEN = "ntn_synthetic_mirror_token";
const T1 = "2026-10-01T10:00:00.000Z";
const T2 = "2026-10-05T10:00:00.000Z";

const DATABASE = {
  id: "db-1",
  title: [{ plain_text: "Bugs" }],
  properties: {
    Name: { id: "t", name: "Name", type: "title" },
    Status: {
      id: "s",
      name: "Status",
      type: "status",
      status: {
        options: [
          { id: "o1", name: "Open" },
          { id: "o2", name: "Fixed" },
        ],
        groups: [],
      },
    },
  },
};

function page(id: string, edited: string, status = "Open"): NotionPage {
  return {
    object: "page",
    id,
    archived: false,
    created_time: T1,
    last_edited_time: edited,
    properties: {
      Name: { id: "t", type: "title", title: [{ plain_text: `Page ${id}` }] },
      Status: { id: "s", type: "status", status: { name: status } },
    },
  };
}

function json(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// Synthetic Notion: no request leaves the process.
function fakeNotion(pages: () => NotionPage[]) {
  const blockReads: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    const { pathname } = new URL(url);
    const method = init?.method ?? "GET";
    if (method === "GET" && pathname === "/v1/databases/db-1") {
      return json(DATABASE);
    }
    if (method === "POST" && pathname === "/v1/databases/db-1/query") {
      return json({ results: pages(), has_more: false, next_cursor: null });
    }
    const block = /^\/v1\/blocks\/([^/]+)\/children$/.exec(pathname);
    if (block?.[1]) {
      blockReads.push(block[1]);
      return json({ results: [], has_more: false, next_cursor: null });
    }
    return new Response(JSON.stringify({ message: `token ${TOKEN}` }), {
      status: 404,
    });
  };
  return { fetch, blockReads };
}

function config(workspaceId: string, tokenFile: string): NotionMirrorConfig {
  return {
    workspaceId,
    databaseIds: ["db-1"],
    tokenFile,
    cron: "7 */2 * * *",
    maxGapHours: 5,
  };
}

function tokenFile(): string {
  const file = join(mkdtempSync(join(tmpdir(), "mirror-run-")), "token");
  writeFileSync(file, `${TOKEN}\n`);
  return file;
}

async function runRow(runId: string) {
  const [row] = await db
    .select()
    .from(notionMirrorRunTable)
    .where(eq(notionMirrorRunTable.id, runId));
  return row;
}

describe("API integration: scheduled Notion mirror (AC-002, AC-003)", () => {
  beforeEach(resetTestDatabase);

  it("syncs, reconciles, and reads bodies only for new or edited pages", async () => {
    const { workspace } = await createWorkspaceMember({ role: "owner" });
    let pages = [page("a", T1), page("b", T1)];
    const notion = fakeNotion(() => pages);
    const mirror = config(workspace.id, tokenFile());

    const first = await mirrorOnce(mirror, "schedule", notion);
    expect(first.status).toBe("clean");
    const firstRow = await runRow(first.runId);
    expect(firstRow?.finishedAt).not.toBeNull();
    expect(firstRow?.report.databases[0]).toMatchObject({
      name: "Bugs",
      read: { pages: 2, fresh: 2, changed: 0 },
      totals: { source: 2, imported: 2 },
      discrepancyCount: 0,
      error: null,
    });
    expect(notion.blockReads.sort()).toEqual(["a", "b"]);

    notion.blockReads.length = 0;
    pages = [page("a", T1), page("b", T2, "Fixed")];
    const second = await mirrorOnce(mirror, "manual", notion);
    expect(second.status).toBe("clean");
    expect((await runRow(second.runId))?.report.databases[0]?.read).toEqual({
      pages: 2,
      fresh: 0,
      changed: 1,
    });
    expect(notion.blockReads).toEqual(["b"]);

    const listed = await listMirrorRuns(workspace.id);
    expect(listed.streak.runs).toBe(2);
    expect(listed.runs.map(({ trigger }) => trigger)).toEqual([
      "manual",
      "schedule",
    ]);
    expect(listed.latest?.id).toBe(second.runId);
  });

  it("reports a card moved on the board and a page Notion dropped", async () => {
    const { workspace } = await createWorkspaceMember({ role: "owner" });
    let pages = [page("a", T1), page("b", T1)];
    const notion = fakeNotion(() => pages);
    const mirror = config(workspace.id, tokenFile());
    await mirrorOnce(mirror, "schedule", notion);

    // Someone moves card a to Fixed on the board; Notion still says Open.
    const [cardA] = await db
      .select({
        taskId: cardMetaTable.taskId,
        projectId: schema.taskTable.projectId,
      })
      .from(cardMetaTable)
      .innerJoin(
        schema.taskTable,
        eq(schema.taskTable.id, cardMetaTable.taskId),
      )
      .where(eq(cardMetaTable.notionPageId, "a"));
    const [fixed] = await db
      .select({ id: schema.columnTable.id, slug: schema.columnTable.slug })
      .from(schema.columnTable)
      .where(
        and(
          eq(schema.columnTable.projectId, cardA?.projectId ?? ""),
          eq(schema.columnTable.slug, "fixed"),
        ),
      );
    await db
      .update(schema.taskTable)
      .set({ status: fixed?.slug ?? "", columnId: fixed?.id ?? null })
      .where(eq(schema.taskTable.id, cardA?.taskId ?? ""));
    pages = [page("a", T1)];

    const run = await mirrorOnce(mirror, "schedule", notion);
    expect(run.status).toBe("discrepancies");
    const report = (await runRow(run.runId))?.report.databases[0];
    expect(
      report?.discrepancies.map(({ pageId, kind }) => [pageId, kind]),
    ).toEqual(
      expect.arrayContaining([
        ["a", "status-mismatch"],
        ["b", "missing-in-source"],
      ]),
    );

    const listed = await listMirrorRuns(workspace.id);
    expect(listed.streak).toMatchObject({ runs: 0, brokenBy: "discrepancies" });
  });

  it("records a failed run without the token when Notion refuses", async () => {
    const { workspace } = await createWorkspaceMember({ role: "owner" });
    const notion = fakeNotion(() => []);
    const mirror = {
      ...config(workspace.id, tokenFile()),
      databaseIds: ["db-missing"],
    };

    const run = await mirrorOnce(mirror, "schedule", notion);
    expect(run.status).toBe("failed");
    const report = (await runRow(run.runId))?.report.databases[0];
    expect(report?.error).toBeTruthy();
    expect(report?.error).not.toContain(TOKEN);
  });

  it("records a failed run when the token file is missing", async () => {
    const { workspace } = await createWorkspaceMember({ role: "owner" });
    const run = await mirrorOnce(
      config(workspace.id, "/nonexistent/notion-token"),
      "schedule",
      fakeNotion(() => []),
    );
    expect(run.status).toBe("failed");
    expect((await runRow(run.runId))?.report.databases[0]).toMatchObject({
      databaseId: "(setup)",
      error: "NOTION_MIRROR_TOKEN_FILE could not be read (ENOENT)",
    });
  });
});
