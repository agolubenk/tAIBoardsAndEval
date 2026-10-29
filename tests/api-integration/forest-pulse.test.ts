import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";
import { createForest } from "./helpers/forest";

// Synthetic cards and journal entries only.
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

function asMember(user: typeof schema.userTable.$inferSelect) {
  return async (path: string) => {
    mockAuthenticatedSession(user);
    const { app } = createApp();
    const response = await app.request(`/api${path}`);
    return { status: response.status, body: await response.json() };
  };
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

async function card(
  projectId: string,
  title: string,
  createdMinutesAgo: number,
  fields: { status?: string; priority?: string } = {},
  meta?: { workspaceId: string; severity: string | null },
) {
  const [task] = await db
    .insert(schema.taskTable)
    .values({
      projectId,
      title,
      number: null,
      status: fields.status ?? "to-do",
      priority: fields.priority ?? "low",
      createdAt: minutesAgo(createdMinutesAgo),
    })
    .returning();
  if (!task) throw new Error("task not created");
  if (meta) {
    await db.insert(schema.cardMetaTable).values({
      taskId: task.id,
      workspaceId: meta.workspaceId,
      kind: "bug",
      severity: meta.severity,
      updatedBy: "test",
    });
  }
  return task;
}

describe("API integration: forest pulse (R-090)", () => {
  beforeEach(resetTestDatabase);

  it("lists open bugs and urgent cards, hot bugs first, oldest first", async () => {
    const forest = await createForest();
    const ws = forest.workspace.id;
    const p = forest.project.id;
    const bug = (severity: string | null) => ({ workspaceId: ws, severity });

    const high = await card(p, "Падает вход", 50, {}, bug("High"));
    const minor = await card(p, "Опечатка", 40, {}, bug("minor"));
    const urgent = await card(p, "Срочный релиз", 30, { priority: "urgent" });
    const critical = await card(p, "Теряются данные", 20, {}, bug("Критичная"));
    await card(p, "Закрытый баг", 60, { status: "done" }, bug("High"));
    await card(p, "В архиве", 60, { status: "archived" }, bug("High"));
    await card(p, "Обычная задача", 60, { priority: "high" });
    const { project: archived } = await createProjectFixture({
      workspaceId: ws,
    });
    await card(archived.id, "Баг архивного проекта", 60, {}, bug("High"));
    await db
      .update(schema.projectTable)
      .set({ archivedAt: new Date() })
      .where(eq(schema.projectTable.id, archived.id));

    const fires = await forest.owner("/fires");
    expect(fires.status).toBe(200);
    expect(fires.body.total).toBe(4);
    expect(
      fires.body.items.map((item: { taskId: string; hot: boolean }) => [
        item.taskId,
        item.hot,
      ]),
    ).toEqual([
      [high.id, true],
      [critical.id, true],
      [urgent.id, false],
      [minor.id, false],
    ]);

    const two = await forest.owner("/fires?take=2");
    expect(two.body.total).toBe(4);
    expect(two.body.items).toHaveLength(2);
  });

  it("hides fires in projects a member may not open", async () => {
    const forest = await createForest();
    const ws = forest.workspace.id;
    const { project: closed } = await createProjectFixture({ workspaceId: ws });
    const open = await card(forest.project.id, "Открытый", 10, {
      priority: "urgent",
    });
    await card(closed.id, "Закрытый", 20, { priority: "urgent" });
    const member = await addRestrictedMember(ws);
    await db.insert(schema.workspaceMemberProjectTable).values({
      workspaceId: ws,
      userId: member.id,
      projectId: forest.project.id,
    });

    expect((await forest.owner("/fires")).body.total).toBe(2);
    const seen = await asMember(member)(`/forest/${ws}/fires`);
    expect(seen.status).toBe(200);
    expect(seen.body).toMatchObject({ total: 1, items: [{ taskId: open.id }] });
  });

  it("feeds agents' actions newest first and keeps others' cards out", async () => {
    const forest = await createForest();
    const ws = forest.workspace.id;
    const { project: closed } = await createProjectFixture({ workspaceId: ws });
    const openCard = await card(forest.project.id, "Видимая", 60);
    const closedCard = await card(closed.id, "Скрытая", 60);
    const { workspace: foreign } = await createWorkspaceMember();
    const entry = (
      minutes: number,
      fields: Partial<typeof schema.agentJournalTable.$inferInsert>,
    ) => ({
      workspaceId: ws,
      actorKind: "agent",
      actorId: "key:k1:dev",
      actorName: "dev",
      action: "task.update",
      targetType: "task",
      targetId: openCard.id,
      outcome: "allowed",
      createdAt: minutesAgo(minutes),
      ...fields,
    });
    await db.insert(schema.agentJournalTable).values([
      entry(50, { detail: "status" }),
      entry(40, {
        action: "task.delete",
        targetId: closedCard.id,
        outcome: "denied",
      }),
      entry(30, { actorKind: "owner-ui", actorName: "Owner" }),
      entry(20, { action: "fell", targetId: "gone-task" }),
      entry(10, {
        action: "approval.decide",
        targetType: "approval",
        targetId: "approval-1",
        outcome: "denied",
      }),
      entry(5, { workspaceId: foreign.id }),
      entry(5, { workspaceId: null, targetType: "mcp_tool", targetId: "x" }),
    ]);
    const targets = (body: { items: { targetId: string }[] }) =>
      body.items.map((item) => item.targetId);

    const agents = await forest.owner("/journal");
    expect(agents.status).toBe(200);
    expect(targets(agents.body)).toEqual([
      "approval-1",
      "gone-task",
      closedCard.id,
      openCard.id,
    ]);
    expect(agents.body.items[3]).toMatchObject({
      taskTitle: "Видимая",
      projectId: forest.project.id,
      detail: "status",
    });
    expect((await forest.owner("/journal?actor=all")).body.items).toHaveLength(
      5,
    );
    expect(
      targets((await forest.owner("/journal?outcome=denied")).body),
    ).toEqual(["approval-1", closedCard.id]);

    const first = await forest.owner("/journal?take=3");
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const rest = await forest.owner(
      `/journal?take=3&cursor=${first.body.nextCursor}`,
    );
    expect(targets(rest.body)).toEqual([openCard.id]);
    expect(rest.body.nextCursor).toBeNull();

    // A restricted member sees neither the closed project's card nor a card
    // that is gone: nobody can tell any more which project it was in.
    const member = await addRestrictedMember(ws);
    await db.insert(schema.workspaceMemberProjectTable).values({
      workspaceId: ws,
      userId: member.id,
      projectId: forest.project.id,
    });
    const seen = await asMember(member)(`/forest/${ws}/journal`);
    expect(seen.status).toBe(200);
    expect(targets(seen.body)).toEqual(["approval-1", openCard.id]);
  });
});
