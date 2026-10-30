import { beforeEach, describe, expect, it } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";
import { createForest, relate } from "./helpers/forest";
import { addRestrictedMember, asMember } from "./helpers/forest-members";

// Synthetic cards only.
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

async function card(
  projectId: string,
  title: string,
  createdMinutesAgo: number,
  fields: { description?: string; files?: string[]; workspaceId?: string } = {},
) {
  const [task] = await db
    .insert(schema.taskTable)
    .values({
      projectId,
      title,
      description: fields.description ?? null,
      number: null,
      status: "to-do",
      createdAt: minutesAgo(createdMinutesAgo),
    })
    .returning();
  if (!task) throw new Error("task not created");
  if (fields.files && fields.workspaceId) {
    await db.insert(schema.cardMetaTable).values({
      taskId: task.id,
      workspaceId: fields.workspaceId,
      files: fields.files,
      updatedBy: "test",
    });
  }
  return task;
}

async function sector(
  workspaceId: string,
  name: string,
  taskIds: string[],
  status = "active",
) {
  const [row] = await db
    .insert(schema.sectorTable)
    .values({
      workspaceId,
      name,
      detectedBy: "links-v1",
      signature: `${name}-${status}`,
      status,
    })
    .returning();
  if (!row) throw new Error("sector not created");
  await db
    .insert(schema.sectorTreeTable)
    .values(taskIds.map((taskId) => ({ sectorId: row.id, taskId })));
  return row;
}

type Graph = {
  cards: { id: string; sectorIds: string[] }[];
  files: { id: string; path: string }[];
  decisions: { id: string; ref: string }[];
  edges: { source: string; target: string; type: string }[];
  sectors: { id: string; name: string }[];
  nextCursor: string | null;
};

const edgeKeys = (graph: Pick<Graph, "edges">) =>
  graph.edges.map((edge) => `${edge.type} ${edge.source} ${edge.target}`);

// Two trees in a sector, a subtask, files and decisions shared between cards,
// and a card in a project the member may not open, linked both ways.
async function plantGraph() {
  const forest = await createForest();
  const ws = forest.workspace.id;
  const p = forest.project.id;
  const { project: hidden } = await createProjectFixture({ workspaceId: ws });

  const a = await card(p, "Вход", 30, {
    description: "Схема токена по D-011, см. ADR 5.",
    files: ["src/auth.ts:12", "src/shared.ts"],
    workspaceId: ws,
  });
  const b = await card(p, "Отчёты", 20, {
    description: "Тоже по D-011",
    files: ["src/shared.ts#L3"],
    workspaceId: ws,
  });
  const child = await card(p, "Подзадача входа", 10);
  const secret = await card(hidden.id, "Секрет ADR-099", 5, {
    files: ["src/secret.ts", "src/shared.ts"],
    workspaceId: ws,
  });
  await relate(a.id, child.id, "subtask");
  await relate(a.id, b.id, "blocks");
  await relate(b.id, secret.id, "related");
  await relate(secret.id, a.id, "blocks");
  const migration = await sector(ws, "Миграция auth", [a.id, b.id]);
  await sector(ws, "Старый", [b.id], "stale");

  return { forest, ws, p, a, b, child, secret, migration };
}

describe("API integration: forest links graph (R-090)", () => {
  beforeEach(resetTestDatabase);

  it("joins cards, files and decisions by links and groups them by sector", async () => {
    const { forest, a, b, child, secret, migration } = await plantGraph();

    const graph = await forest.owner("/graph");
    expect(graph.status).toBe(200);
    const body = graph.body as Graph;
    expect(body.cards.map((node) => node.id)).toEqual([
      secret.id,
      child.id,
      b.id,
      a.id,
    ]);
    // A tree's sector reaches its subtasks; a stale sector is not shown.
    const sectorsOf = (id: string) =>
      body.cards.find((node) => node.id === id)?.sectorIds;
    expect(sectorsOf(a.id)).toEqual([migration.id]);
    expect(sectorsOf(child.id)).toEqual([migration.id]);
    expect(sectorsOf(b.id)).toEqual([migration.id]);
    expect(sectorsOf(secret.id)).toEqual([]);
    expect(body.sectors).toEqual([{ id: migration.id, name: "Миграция auth" }]);
    // One node per file whatever the line, one per decision however spelled.
    expect(body.files.map((file) => file.path).sort()).toEqual([
      "src/auth.ts",
      "src/secret.ts",
      "src/shared.ts",
    ]);
    expect(body.decisions.map((decision) => decision.ref).sort()).toEqual([
      "ADR-005",
      "ADR-099",
      "D-011",
    ]);
    expect(edgeKeys(body).sort()).toEqual(
      [
        `subtask ${a.id} ${child.id}`,
        `blocks ${a.id} ${b.id}`,
        `related ${b.id} ${secret.id}`,
        `blocks ${secret.id} ${a.id}`,
        `file ${a.id} file:src/auth.ts`,
        `file ${a.id} file:src/shared.ts`,
        `file ${b.id} file:src/shared.ts`,
        `file ${secret.id} file:src/secret.ts`,
        `file ${secret.id} file:src/shared.ts`,
        `decision ${a.id} decision:D-011`,
        `decision ${a.id} decision:ADR-005`,
        `decision ${b.id} decision:D-011`,
        `decision ${secret.id} decision:ADR-099`,
      ].sort(),
    );
    expect(body.nextCursor).toBeNull();
  });

  it("pages by nodes, sends each link once and leaves out what a member may not open", async () => {
    const { ws, p, a, b, child, secret } = await plantGraph();
    const member = await addRestrictedMember(ws);
    await db.insert(schema.workspaceMemberProjectTable).values({
      workspaceId: ws,
      userId: member.id,
      projectId: p,
    });
    const read = asMember(member);

    const pages: Graph[] = [];
    let cursor: string | null = "";
    while (cursor !== null) {
      const query: string = cursor ? `&cursor=${cursor}` : "";
      const page = await read(`/forest/${ws}/graph?take=5${query}`);
      expect(page.status).toBe(200);
      pages.push(page.body as Graph);
      cursor = (page.body as Graph).nextCursor;
      expect(pages.length).toBeLessThan(5);
    }

    // child and b fill the first page (4 nodes); a with its files and
    // decisions (5 nodes) would overflow it, so it opens the second.
    expect(pages.map((page) => page.cards.map((node) => node.id))).toEqual([
      [child.id, b.id],
      [a.id],
    ]);
    for (const page of pages) {
      const nodes =
        page.cards.length + page.files.length + page.decisions.length;
      expect(nodes).toBeLessThanOrEqual(5);
    }
    const edges = pages.flatMap(edgeKeys);
    expect(new Set(edges).size).toBe(edges.length);
    // The links to the first page's cards arrive with the older card.
    expect(edgeKeys(pages[1] as Graph)).toEqual(
      expect.arrayContaining([
        `subtask ${a.id} ${child.id}`,
        `blocks ${a.id} ${b.id}`,
      ]),
    );
    expect(edges.sort()).toEqual(
      [
        `subtask ${a.id} ${child.id}`,
        `blocks ${a.id} ${b.id}`,
        `file ${a.id} file:src/auth.ts`,
        `file ${a.id} file:src/shared.ts`,
        `file ${b.id} file:src/shared.ts`,
        `decision ${a.id} decision:D-011`,
        `decision ${a.id} decision:ADR-005`,
        `decision ${b.id} decision:D-011`,
      ].sort(),
    );
    const seen = JSON.stringify(pages);
    expect(seen).not.toContain(secret.id);
    expect(seen).not.toContain("src/secret.ts");
    expect(seen).not.toContain("ADR-099");
  });

  it("keeps other workspaces out and refuses a broken cursor", async () => {
    const forest = await createForest();
    const own = await card(forest.project.id, "Своя", 10);
    const { workspace: foreign } = await createWorkspaceMember();
    const { project: foreignProject } = await createProjectFixture({
      workspaceId: foreign.id,
    });
    const other = await card(foreignProject.id, "Чужая", 5);
    await relate(own.id, other.id, "related");

    const graph = await forest.owner("/graph");
    expect((graph.body as Graph).cards.map((node) => node.id)).toEqual([
      own.id,
    ]);
    expect((graph.body as Graph).edges).toEqual([]);
    expect((await forest.owner("/graph?cursor=broken")).status).toBe(400);
  });
});
