import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";
import { readErrorBody } from "./helpers/error-body";

const m = vi.hoisted(() => ({ publish: vi.fn(async () => undefined) }));
vi.mock("../../apps/api/src/events", async (original) => ({
  ...(await original<object>()),
  publishEvent: m.publish,
}));
beforeEach(async () => {
  await resetTestDatabase();
  vi.clearAllMocks();
});
async function context() {
  const member = await createWorkspaceMember();
  const { project } = await createProjectFixture({
    workspaceId: member.workspace.id,
  });
  const [task] = await db
    .insert(schema.taskTable)
    .values({ projectId: project.id, title: "Private title", number: 1 })
    .returning();
  return { ...member, task };
}
function request(path: string, method: string, body?: unknown) {
  return createApp().app.request(`/api/task-relation${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
}
async function seedRelation(sourceTaskId: string, targetTaskId: string) {
  const [relation] = await db
    .insert(schema.taskRelationTable)
    .values({ sourceTaskId, targetTaskId, relationType: "blocks" })
    .returning();
  return relation;
}

describe("task relation tenant boundaries", () => {
  it("rejects a foreign target and a nonexistent target identically", async () => {
    const own = await context();
    const foreign = await context();
    mockAuthenticatedSession(own.user);
    for (const targetTaskId of [foreign.task.id, "missing-task"]) {
      const response = await request("", "POST", {
        sourceTaskId: own.task.id,
        targetTaskId,
        relationType: "blocks",
      });
      expect(response.status).toBe(404);
      expect(await readErrorBody(response)).toMatchObject({
        message: "Target task not found",
        code: "NOT_FOUND",
      });
    }
    expect(await db.query.taskRelationTable.findMany()).toHaveLength(0);
    expect(m.publish).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "hides legacy cross-workspace relations from reads in either direction (reverse=%s)",
    async (reverse) => {
      const own = await context();
      const foreign = await context();
      await seedRelation(
        reverse ? foreign.task.id : own.task.id,
        reverse ? own.task.id : foreign.task.id,
      );
      for (const member of [own, foreign]) {
        mockAuthenticatedSession(member.user);
        const response = await request(`/${member.task.id}`, "GET");
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual([]);
      }
    },
  );

  it("rejects deletion of a legacy foreign-target row without mutation or event", async () => {
    const own = await context();
    const foreign = await context();
    const relation = await seedRelation(own.task.id, foreign.task.id);
    mockAuthenticatedSession(own.user);
    const response = await request(`/${relation.id}`, "DELETE");
    expect(response.status).toBe(404);
    expect(await readErrorBody(response)).toMatchObject({
      message: "Task relation not found",
      code: "NOT_FOUND",
    });
    expect(
      await db.query.taskRelationTable.findFirst({
        where: eq(schema.taskRelationTable.id, relation.id),
      }),
    ).toBeDefined();
    expect(m.publish).not.toHaveBeenCalled();
  });

  it("requires source-workspace access for deletion even when the target is owned", async () => {
    const own = await context();
    const foreign = await context();
    const relation = await seedRelation(foreign.task.id, own.task.id);
    mockAuthenticatedSession(own.user);
    const response = await request(`/${relation.id}`, "DELETE");
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("Task relation not found");
    expect(await db.query.taskRelationTable.findMany()).toHaveLength(1);
    expect(m.publish).not.toHaveBeenCalled();
  });

  it("keeps same-workspace cross-project relations fully usable", async () => {
    const own = await context();
    const { project } = await createProjectFixture({
      workspaceId: own.workspace.id,
    });
    const [target] = await db
      .insert(schema.taskTable)
      .values({ projectId: project.id, title: "Related", number: 1 })
      .returning();
    mockAuthenticatedSession(own.user);
    const created = await request("", "POST", {
      sourceTaskId: own.task.id,
      targetTaskId: target.id,
      relationType: "related",
    });
    expect(created.status).toBe(200);
    const relation = (await created.json()) as { id: string };
    for (const task of [own.task, target]) {
      const response = await request(`/${task.id}`, "GET");
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject([
        {
          id: relation.id,
          sourceTask: { id: own.task.id },
          targetTask: { id: target.id },
        },
      ]);
    }
    expect((await request(`/${relation.id}`, "DELETE")).status).toBe(200);
    expect(await db.query.taskRelationTable.findMany()).toHaveLength(0);
    expect(m.publish).toHaveBeenCalledWith(
      "task-relation.deleted",
      expect.objectContaining({
        sourceTaskId: own.task.id,
        targetTaskId: target.id,
      }),
    );
  });
});

describe("subtask links stay a forest", () => {
  async function addCard(projectId: string, title: string) {
    const [task] = await db
      .insert(schema.taskTable)
      .values({ projectId, title, number: null })
      .returning();
    return task;
  }

  it("refuses a subtask link that would close a cycle through any ancestor", async () => {
    const own = await context();
    mockAuthenticatedSession(own.user);
    const a = own.task;
    const b = await addCard(a.projectId, "B");
    const c = await addCard(a.projectId, "C");
    const link = (
      sourceTaskId: string,
      targetTaskId: string,
      relationType = "subtask",
    ) => request("", "POST", { sourceTaskId, targetTaskId, relationType });

    expect((await link(a.id, b.id)).status).toBe(200);
    expect((await link(b.id, c.id)).status).toBe(200);

    // The reversed pair was already refused as a duplicate of the same link.
    expect((await link(b.id, a.id)).status).toBe(409);
    // A cycle through an ancestor is what the duplicate check missed.
    const deep = await link(c.id, a.id);
    expect(deep.status).toBe(409);
    expect((await readErrorBody(deep)).message).toContain("subtask_cycle");

    // Other relation types are not tree edges and stay allowed.
    expect((await link(c.id, a.id, "related")).status).toBe(200);
    const subtasks = await db
      .select()
      .from(schema.taskRelationTable)
      .where(eq(schema.taskRelationTable.relationType, "subtask"));
    expect(subtasks).toHaveLength(2);
  });
});
