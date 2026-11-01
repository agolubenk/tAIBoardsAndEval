import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import { addTask, createForest } from "./helpers/forest";

type Row = { actorName: string; step: string; taskId: string | null };

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

describe("API integration: forest work state (R-037)", () => {
  beforeEach(resetTestDatabase);

  it("keeps one row per session, replaces it on write and clears it", async () => {
    const forest = await createForest();
    const task = await addTask(forest.project.id, "Аренда");
    if (!task) throw new Error("task not created");
    const put = (session: string, body: unknown) =>
      forest.agentApi(
        "PUT",
        `/forest/${forest.workspace.id}/work-state`,
        body,
        {},
        session,
      );

    const first = await put("dev #1", {
      step: "Пишу миграцию",
      taskId: task.id,
      branch: "feat/work-state",
      waiting: "ревью",
    });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      taskId: task.id,
      step: "Пишу миграцию",
      branch: "feat/work-state",
      waiting: "ревью",
    });
    await put("dev #2", { step: "Читаю спеку" });
    // Optional fields left out are cleared: the write replaces the state.
    await put("dev #1", { step: "Гоняю тесты", taskId: task.id });

    const list = await forest.agent("/work-state");
    expect(list.status).toBe(200);
    expect(
      list.body.map((row: Row & { waiting: string | null }) => [
        row.actorName,
        row.step,
        row.waiting,
      ]),
    ).toEqual([
      ["dev #1", "Гоняю тесты", null],
      ["dev #2", "Читаю спеку", null],
    ]);
    expect(list.body[0]).toMatchObject({
      actorKind: "agent",
      taskId: task.id,
      title: "Аренда",
      projectId: forest.project.id,
    });

    const clear = () =>
      forest.agentApi(
        "DELETE",
        `/forest/${forest.workspace.id}/work-state`,
        undefined,
        {},
        "dev #1",
      );
    expect((await clear()).body).toEqual({ removed: true });
    expect((await clear()).body).toEqual({ removed: false });
    expect(
      (await forest.owner("/work-state")).body.map((row: Row) => row.actorName),
    ).toEqual(["dev #2"]);
  });

  it("hides sessions on cards of projects the reader may not open", async () => {
    const forest = await createForest();
    const task = await addTask(forest.project.id, "Закрытая");
    if (!task) throw new Error("task not created");
    const path = `/forest/${forest.workspace.id}/work-state`;
    await forest.agentApi(
      "PUT",
      path,
      { step: "Секрет", taskId: task.id },
      {},
      "a",
    );
    await forest.agentApi("PUT", path, { step: "Общее" }, {}, "b");

    const member = await addRestrictedMember(forest.workspace.id);
    mockAuthenticatedSession(member);
    const { app } = createApp();
    const read = async () => {
      const response = await app.request(`/api${path}`);
      expect(response.status).toBe(200);
      return ((await response.json()) as Row[]).map((row) => row.step);
    };
    expect(await read()).toEqual(["Общее"]);

    await db.insert(schema.workspaceMemberProjectTable).values({
      workspaceId: forest.workspace.id,
      userId: member.id,
      projectId: forest.project.id,
    });
    expect((await read()).sort()).toEqual(["Общее", "Секрет"]);
  });

  it("refuses a card of another workspace and drops rows with their card or after 30 days", async () => {
    const forest = await createForest();
    const other = await createForest();
    const foreign = await addTask(other.project.id, "Чужая");
    const task = await addTask(forest.project.id, "Своя");
    if (!foreign || !task) throw new Error("tasks not created");
    const path = `/forest/${forest.workspace.id}/work-state`;

    const refused = await forest.agentApi(
      "PUT",
      path,
      { step: "Шаг", taskId: foreign.id },
      {},
      "a",
    );
    expect(refused.status).toBe(404);
    expect(
      (await forest.agentApi("PUT", path, { step: "  " }, {}, "a")).status,
    ).toBe(400);

    await forest.agentApi(
      "PUT",
      path,
      { step: "Шаг", taskId: task.id },
      {},
      "a",
    );
    await db.delete(schema.taskTable).where(eq(schema.taskTable.id, task.id));
    expect((await forest.agent("/work-state")).body).toEqual([]);

    await forest.agentApi("PUT", path, { step: "Старое" }, {}, "old");
    await db
      .update(schema.sessionWorkStateTable)
      .set({ updatedAt: new Date(Date.now() - 31 * 86_400_000) })
      .where(eq(schema.sessionWorkStateTable.actorName, "old"));
    await forest.agentApi("PUT", path, { step: "Новое" }, {}, "new");
    expect(
      (await forest.agent("/work-state")).body.map((row: Row) => row.actorName),
    ).toEqual(["new"]);
  });

  it("needs task:update to write", async () => {
    const forest = await createForest();
    const member = await addRestrictedMember(forest.workspace.id);
    await db
      .update(schema.workspaceUserTable)
      .set({ role: "viewer" })
      .where(eq(schema.workspaceUserTable.userId, member.id));
    mockAuthenticatedSession(member);
    const { app } = createApp();
    const response = await app.request(
      `/api/forest/${forest.workspace.id}/work-state`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ step: "Шаг" }),
      },
    );
    expect(response.status).toBe(403);
  });
});
