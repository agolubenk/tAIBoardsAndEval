import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import { resetTestDatabase } from "./helpers/database";
import { addTask, createForest } from "./helpers/forest";

const LONG_AGO = new Date("2026-01-02T03:04:05.000Z");

async function completedAt(taskId: string) {
  const [row] = await db
    .select({ completedAt: schema.taskTable.completedAt })
    .from(schema.taskTable)
    .where(eq(schema.taskTable.id, taskId));
  return row?.completedAt ?? null;
}

async function stamp(taskId: string, at: Date) {
  await db
    .update(schema.taskTable)
    .set({ completedAt: at })
    .where(eq(schema.taskTable.id, taskId));
}

describe("API integration: a card's end date (d-tb-card-fill)", () => {
  beforeEach(resetTestDatabase);

  it("dates a card entering a final column and clears it on the way out", async () => {
    const forest = await createForest();
    const task = await addTask(forest.project.id, "Card");
    if (!task) throw new Error("fixture");
    expect(await completedAt(task.id)).toBeNull();

    const done = await forest.ownerApi("PUT", `/task/status/${task.id}`, {
      status: "done",
    });
    expect(done.status).toBe(200);
    const read = await forest.ownerApi("GET", `/task/${task.id}`);
    expect(read.body.completedAt).toEqual(expect.any(String));

    await stamp(task.id, LONG_AGO);
    await db
      .update(schema.taskTable)
      .set({ title: "Renamed", status: "done" })
      .where(eq(schema.taskTable.id, task.id));
    expect(await completedAt(task.id)).toEqual(LONG_AGO);

    await forest.ownerApi("PUT", `/task/status/${task.id}`, {
      status: "in-progress",
    });
    expect(await completedAt(task.id)).toBeNull();

    await forest.ownerApi("PUT", `/task/status/${task.id}`, { status: "done" });
    const reopened = await completedAt(task.id);
    expect(reopened).not.toBeNull();
    expect(reopened?.getTime()).toBeGreaterThan(LONG_AGO.getTime());
  });

  it("keeps the first date across final columns and follows bulk moves", async () => {
    const forest = await createForest();
    await db.insert(schema.columnTable).values({
      projectId: forest.project.id,
      name: "Archived",
      slug: "archived",
      position: 9,
      isFinal: true,
    });
    const a = await addTask(forest.project.id, "A");
    const b = await addTask(forest.project.id, "B");
    if (!a || !b) throw new Error("fixture");

    const bulk = await forest.ownerApi("PATCH", "/task/bulk", {
      taskIds: [a.id, b.id],
      operation: "updateStatus",
      value: "done",
    });
    expect(bulk.status).toBe(200);
    expect(await completedAt(a.id)).not.toBeNull();
    expect(await completedAt(b.id)).not.toBeNull();

    await stamp(a.id, LONG_AGO);
    await forest.ownerApi("PUT", `/task/status/${a.id}`, {
      status: "archived",
    });
    expect(await completedAt(a.id)).toEqual(LONG_AGO);

    const [created] = await db
      .insert(schema.taskTable)
      .values({
        projectId: forest.project.id,
        title: "Born done",
        status: "done",
        number: null,
      })
      .returning();
    expect(created?.completedAt).toEqual(expect.any(Date));
  });

  it("follows a column turning final or not and a move to another project", async () => {
    const forest = await createForest();
    const task = await addTask(forest.project.id, "Card");
    if (!task) throw new Error("fixture");
    await forest.ownerApi("PUT", `/task/status/${task.id}`, {
      status: "in-review",
    });
    expect(await completedAt(task.id)).toBeNull();

    const review = and(
      eq(schema.columnTable.projectId, forest.project.id),
      eq(schema.columnTable.slug, "in-review"),
    );
    await db.update(schema.columnTable).set({ isFinal: true }).where(review);
    expect(await completedAt(task.id)).not.toBeNull();
    await db.update(schema.columnTable).set({ isFinal: false }).where(review);
    expect(await completedAt(task.id)).toBeNull();

    await forest.ownerApi("PUT", `/task/status/${task.id}`, { status: "done" });
    expect(await completedAt(task.id)).not.toBeNull();
    const [other] = await db
      .insert(schema.projectTable)
      .values({
        workspaceId: forest.workspace.id,
        name: "Other",
        icon: "Folder",
        slug: "other-project",
      })
      .returning();
    if (!other) throw new Error("fixture");
    await db.insert(schema.columnTable).values({
      projectId: other.id,
      name: "To do",
      slug: "to-do",
      position: 0,
      isFinal: false,
    });
    await db
      .update(schema.taskTable)
      .set({ projectId: other.id, status: "to-do" })
      .where(eq(schema.taskTable.id, task.id));
    expect(await completedAt(task.id)).toBeNull();
  });
});
