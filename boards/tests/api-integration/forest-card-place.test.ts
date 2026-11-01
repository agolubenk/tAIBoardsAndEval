import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import { resetTestDatabase } from "./helpers/database";
import { addTask, createForest, relate } from "./helpers/forest";

describe("API integration: where a card sits in the forest", () => {
  beforeEach(resetTestDatabase);

  it("shows the path to the root, subcards with progress and the tree's sector", async () => {
    const forest = await createForest();
    const root = await addTask(forest.project.id, "Root");
    const branch = await addTask(forest.project.id, "Branch");
    const twig = await addTask(forest.project.id, "Twig");
    const neighbour = await addTask(forest.project.id, "Neighbour");
    if (!root || !branch || !twig || !neighbour) throw new Error("fixture");
    await relate(root.id, branch.id, "subtask");
    await relate(branch.id, twig.id, "subtask");
    await relate(root.id, neighbour.id, "blocks");
    await db
      .update(schema.taskTable)
      .set({ status: "done" })
      .where(eq(schema.taskTable.id, twig.id));
    const detected = await forest.agent("/sectors/detect", {});
    expect(detected.status).toBe(200);

    const place = await forest.owner(`/cards/${branch.id}/place`);
    expect(place.status).toBe(200);
    expect(place.body).toMatchObject({
      rootId: root.id,
      ancestors: [{ id: root.id, title: "Root" }],
      hiddenAncestors: 0,
      subcards: { total: 1, done: 1 },
      tree: { total: 2, done: 1 },
    });
    expect(place.body.sectors).toHaveLength(1);

    const top = await forest.owner(`/cards/${root.id}/place`);
    expect(top.body).toMatchObject({
      rootId: root.id,
      ancestors: [],
      subcards: { total: 2, done: 1 },
      tree: { total: 2, done: 1 },
    });
    expect(top.body.sectors).toEqual(place.body.sectors);
  });

  it("ends on a subtask cycle and keeps another workspace's cards out", async () => {
    const forest = await createForest();
    const a = await addTask(forest.project.id, "A");
    const b = await addTask(forest.project.id, "B");
    if (!a || !b) throw new Error("fixture");
    await relate(a.id, b.id, "subtask");
    await relate(b.id, a.id, "subtask");

    const place = await forest.owner(`/cards/${a.id}/place`);
    expect(place.status).toBe(200);
    expect(place.body.ancestors.map((row: { id: string }) => row.id)).toEqual([
      b.id,
    ]);
    expect(place.body.subcards).toEqual({ total: 1, done: 0 });

    const other = await createForest();
    const foreign = await addTask(other.project.id, "Foreign");
    if (!foreign) throw new Error("fixture");
    expect((await forest.owner(`/cards/${foreign.id}/place`)).status).toBe(404);
  });
});
