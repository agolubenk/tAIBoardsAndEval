import { beforeEach, describe, expect, it } from "vite-plus/test";
import { resetTestDatabase } from "./helpers/database";
import { addTask, createForest } from "./helpers/forest";

describe("API integration: who works on a project's cards", () => {
  beforeEach(resetTestDatabase);

  it("names the holder, the session and the executor in one board request", async () => {
    const forest = await createForest();
    const held = await addTask(forest.project.id, "Аренда");
    const stated = await addTask(forest.project.id, "Ревью");
    const idle = await addTask(forest.project.id, "Никто");
    if (!held || !stated || !idle) throw new Error("tasks not created");

    const lease = await forest.agent(
      "/leases",
      { taskId: held.id },
      "backend s-1",
    );
    expect(lease.status).toBe(200);
    const state = await forest.agentApi(
      "PUT",
      `/forest/${forest.workspace.id}/work-state`,
      { taskId: stated.id, step: "Смотрю PR" },
      {},
      "qa s-2",
    );
    expect(state.status).toBe(200);
    const meta = await forest.agentApi(
      "PUT",
      `/forest/${forest.workspace.id}/cards/${held.id}/meta`,
      { executor: "backend s-1" },
      // The card is under the lease, so the write carries its fence.
      { "x-t-boards-fence": String(lease.body.fencingToken) },
      "backend s-1",
    );
    expect(meta.status).toBe(200);

    const res = await forest.owner(`/workers?projectId=${forest.project.id}`);
    expect(res.status).toBe(200);
    const byTask = new Map(
      (res.body as { taskId: string }[]).map((w) => [w.taskId, w]),
    );
    expect(byTask.size).toBe(2);
    expect(byTask.get(held.id)).toMatchObject({
      holder: { name: "backend s-1", kind: "agent" },
      session: null,
      executor: "backend s-1",
    });
    expect(byTask.get(stated.id)).toMatchObject({
      holder: null,
      session: { name: "qa s-2", kind: "agent", step: "Смотрю PR" },
      executor: null,
    });

    const other = await forest.owner("/workers?projectId=not-a-project");
    expect(other).toEqual({ status: 200, body: [] });
  });
});
