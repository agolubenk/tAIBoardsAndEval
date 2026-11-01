import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import { resetEmbedQueueForTests } from "../../apps/api/src/notebook/embed/embed-queue";
import { clearVectorCacheForTests } from "../../apps/api/src/notebook/search/vector-index";
import { createApp } from "../../apps/api/src/index";
import { syncNotebookCards } from "../../apps/api/src/scheduler/notebook-card-sync";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import { createProjectFixture } from "./helpers/fixtures";
import { createForest } from "./helpers/forest";

// Synthetic cards only.
async function cardsFixture() {
  const forest = await createForest();
  const { project } = await createProjectFixture({
    workspaceId: forest.workspace.id,
    slug: "aib",
  });
  const [lease, felling] = await db
    .insert(schema.taskTable)
    .values([
      {
        projectId: project.id,
        number: 1,
        title: "Аренда карточек",
        status: "to-do",
        description:
          "Аренда истекает через час.\n\n## Приёмка\n\nToken растёт.",
      },
      {
        projectId: project.id,
        number: 2,
        title: "Рубка",
        status: "done",
        description: "Ветка становится бревном.",
      },
    ])
    .returning();
  if (!lease || !felling) throw new Error("tasks not created");
  await db.insert(schema.cardMetaTable).values({
    taskId: lease.id,
    workspaceId: forest.workspace.id,
    report: "Сделано, fencing проверен.",
    updatedBy: "test",
  });
  const path = (rest: string) => `/notebook/${forest.workspace.id}${rest}`;
  return {
    ...forest,
    cardProject: project,
    lease,
    felling,
    owner: (method: string, rest: string, body?: unknown) =>
      forest.ownerApi(method, path(rest), body),
    path,
  };
}

async function addRestrictedMember(workspaceId: string) {
  const [user] = await db
    .insert(schema.userTable)
    .values({
      id: `user-${randomUUID()}`,
      email: `${randomUUID()}@example.com`,
      emailVerified: true,
      name: "Restricted",
    })
    .returning();
  if (!user) throw new Error("user not created");
  await db.insert(schema.workspaceUserTable).values({
    workspaceId,
    userId: user.id,
    role: "member",
    joinedAt: new Date(),
  });
  await db.insert(schema.workspaceMemberAccessTable).values({
    workspaceId,
    userId: user.id,
    projectAccess: "selected",
  });
  return user;
}

describe("API integration: notebook cards", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    clearVectorCacheForTests();
  });
  afterEach(resetEmbedQueueForTests);

  it("syncs cards once, finds them in search and re-cuts only an edited card", async () => {
    const nb = await cardsFixture();

    const first = await nb.owner("POST", "/sources/cards");
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ cards: 2, changed: 2, pruned: 0 });
    expect((await nb.owner("POST", "/sources/cards")).body).toEqual({
      cards: 2,
      changed: 0,
      pruned: 0,
    });

    const sources = await nb.owner("GET", "/sources");
    expect(
      sources.body.sources
        .filter((s: { kind: string }) => s.kind === "card")
        .map((s: { ref: string; title: string }) => [s.ref, s.title])
        .sort(),
    ).toEqual(
      [
        [nb.lease.id, "AIB-1 Аренда карточек"],
        [nb.felling.id, "AIB-2 Рубка"],
      ].sort(),
    );

    const search = await nb.owner("POST", "/search", {
      query: "fencing",
      mode: "keyword",
    });
    expect(search.status).toBe(200);
    expect(search.body.results[0]).toMatchObject({
      source: {
        kind: "card",
        ref: nb.lease.id,
        title: "AIB-1 Аренда карточек",
      },
      heading: "AIB-1 Аренда карточек › Report",
    });

    await db
      .update(schema.taskTable)
      .set({ description: "Ветка становится бревном и семенами." })
      .where(eq(schema.taskTable.id, nb.felling.id));
    expect((await nb.owner("POST", "/sources/cards")).body).toEqual({
      cards: 2,
      changed: 1,
      pruned: 0,
    });
  });

  it("keeps out cards of a project some member may not open, and of archived projects", async () => {
    const nb = await cardsFixture();
    await nb.owner("POST", "/sources/cards");

    const member = await addRestrictedMember(nb.workspace.id);
    const hidden = await nb.owner("POST", "/sources/cards");
    expect(hidden.body).toEqual({ cards: 0, changed: 0, pruned: 2 });
    const search = await nb.owner("POST", "/search", {
      query: "fencing",
      mode: "keyword",
    });
    expect(search.body.results).toEqual([]);

    // createForest's own project has no tasks; granting both makes every
    // project open to the restricted member again.
    await db.insert(schema.workspaceMemberProjectTable).values([
      {
        workspaceId: nb.workspace.id,
        userId: member.id,
        projectId: nb.cardProject.id,
      },
      {
        workspaceId: nb.workspace.id,
        userId: member.id,
        projectId: nb.project.id,
      },
    ]);
    expect((await nb.owner("POST", "/sources/cards")).body).toEqual({
      cards: 2,
      changed: 2,
      pruned: 0,
    });

    await db
      .update(schema.projectTable)
      .set({ archivedAt: new Date() })
      .where(eq(schema.projectTable.id, nb.cardProject.id));
    expect((await nb.owner("POST", "/sources/cards")).body).toEqual({
      cards: 0,
      changed: 0,
      pruned: 2,
    });
  });

  it("does not take cards by upload and needs manage_settings to sync", async () => {
    const nb = await cardsFixture();

    const upload = await nb.owner("PUT", "/sources", {
      kind: "card",
      ref: nb.lease.id,
      title: "Подмена",
      text: "Чужой текст",
    });
    expect(upload.status).toBe(400);

    const [member] = await db
      .insert(schema.userTable)
      .values({
        id: `user-${randomUUID()}`,
        email: `${randomUUID()}@example.com`,
        emailVerified: true,
        name: "Reader",
      })
      .returning();
    if (!member) throw new Error("user not created");
    await db.insert(schema.workspaceUserTable).values({
      workspaceId: nb.workspace.id,
      userId: member.id,
      role: "member",
      joinedAt: new Date(),
    });
    mockAuthenticatedSession(member);
    const { app } = createApp();
    const denied = await app.request(`/api${nb.path("/sources/cards")}`, {
      method: "POST",
    });
    expect(denied.status).toBe(403);
  });

  it("runs as a scheduled job over every workspace", async () => {
    const nb = await cardsFixture();

    expect(await syncNotebookCards()).toEqual({ degraded: false });

    const sources = await db
      .select({ ref: schema.notebookSourceTable.ref })
      .from(schema.notebookSourceTable)
      .where(eq(schema.notebookSourceTable.kind, "card"));
    expect(sources.map((s) => s.ref).sort()).toEqual(
      [nb.lease.id, nb.felling.id].sort(),
    );
  });
});
