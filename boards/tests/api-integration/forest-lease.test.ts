import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import db from "../../apps/api/src/database";
import { taskLeaseTable } from "../../apps/api/src/database/forest-schema";
import { resetTestDatabase } from "./helpers/database";
import { addTask, createForest } from "./helpers/forest";

async function expireLease(taskId: string) {
  await db
    .update(taskLeaseTable)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(taskLeaseTable.taskId, taskId));
}

describe("API integration: forest leases", () => {
  beforeEach(resetTestDatabase);

  it("names the holder on a conflict and lets a linked session share the lease", async () => {
    const forest = await createForest();
    const task = await addTask(forest.project.id);

    const first = await forest.agent(
      "/leases",
      { taskId: task.id, groupKey: "pair-1" },
      "writer",
    );
    expect(first.status).toBe(200);
    expect(first.body.fencingToken).toBe(1);

    const rival = await forest.agent("/leases", { taskId: task.id }, "rival");
    expect(rival.status).toBe(409);
    expect(rival.body.message).toContain("lease_conflict");
    expect(rival.body.message).toContain("writer");

    const linked = await forest.agent(
      "/leases",
      { taskId: task.id, groupKey: "pair-1" },
      "reviewer",
    );
    expect(linked.status).toBe(200);
    expect(linked.body.fencingToken).toBe(1);
  });

  it("issues a greater token on takeover and ignores a stale release", async () => {
    const forest = await createForest();
    const task = await addTask(forest.project.id);

    const first = await forest.agent("/leases", { taskId: task.id }, "a");
    expect(first.body.fencingToken).toBe(1);
    await expireLease(task.id);

    const second = await forest.agent("/leases", { taskId: task.id }, "b");
    expect(second.status).toBe(200);
    expect(second.body.fencingToken).toBe(2);

    const stale = await forest.agent(
      "/leases/release",
      { taskId: task.id, fencingToken: 1 },
      "a",
    );
    expect(stale.body).toEqual({ released: false });
    const stillHeld = await forest.agent("/leases", { taskId: task.id }, "c");
    expect(stillHeld.status).toBe(409);

    const release = await forest.agent(
      "/leases/release",
      { taskId: task.id, fencingToken: 2 },
      "b",
    );
    expect(release.body).toEqual({ released: true });
    const third = await forest.agent("/leases", { taskId: task.id }, "c");
    expect(third.body.fencingToken).toBe(3);
  });

  it("hides tasks of other workspaces", async () => {
    const forest = await createForest();
    const other = await createForest();
    const foreign = await addTask(other.project.id);

    const response = await forest.agent("/leases", { taskId: foreign.id });
    expect(response.status).toBe(404);
  });
});
