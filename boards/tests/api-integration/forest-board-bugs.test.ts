import { beforeEach, describe, expect, it } from "vite-plus/test";
import { resetTestDatabase } from "./helpers/database";
import { addTask, createForest } from "./helpers/forest";

describe("API integration: the bugs on a board", () => {
  beforeEach(resetTestDatabase);

  it("marks the cards of kind bug, in the project's own columns", async () => {
    const forest = await createForest();
    const bug = await addTask(forest.project.id, "Падает вход");
    const task = await addTask(forest.project.id, "Задача");
    const fixedKind = await addTask(forest.project.id, "Уже не ошибка");
    if (!bug || !task || !fixedKind) throw new Error("tasks not created");

    const put = (taskId: string, body: unknown) =>
      forest.ownerApi(
        "PUT",
        `/forest/${forest.workspace.id}/cards/${taskId}/meta`,
        body,
      );
    expect((await put(bug.id, { kind: "bug", severity: "high" })).status).toBe(
      200,
    );
    expect((await put(task.id, { executor: "backend" })).status).toBe(200);
    expect((await put(fixedKind.id, { kind: "bug" })).status).toBe(200);
    expect((await put(fixedKind.id, { kind: "task" })).status).toBe(200);

    const res = await forest.owner(`/bugs?projectId=${forest.project.id}`);
    expect(res).toEqual({
      status: 200,
      body: [{ taskId: bug.id, severity: "high" }],
    });

    const other = await forest.owner("/bugs?projectId=not-a-project");
    expect(other).toEqual({ status: 200, body: [] });
  });
});
