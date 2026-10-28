import { beforeEach, describe, expect, it } from "vite-plus/test";
import { resetTestDatabase } from "./helpers/database";
import { addTask, createForest, relate } from "./helpers/forest";

describe("API integration: forest page reads", () => {
  beforeEach(resetTestDatabase);

  it("lists trees with their branches and shows one tree root first", async () => {
    const forest = await createForest();
    const root = await addTask(forest.project.id, "Root");
    const branch = await addTask(forest.project.id, "Branch");
    const twig = await addTask(forest.project.id, "Twig");
    const lone = await addTask(forest.project.id, "Lone tree");
    if (!root || !branch || !twig || !lone) throw new Error("fixture");
    await relate(root.id, branch.id, "subtask");
    await relate(branch.id, twig.id, "subtask");

    const trees = await forest.owner("/trees");
    expect(trees.status).toBe(200);
    const byTitle = Object.fromEntries(
      trees.body.trees.map((tree: { title: string }) => [tree.title, tree]),
    );
    expect(Object.keys(byTitle).sort()).toEqual(["Lone tree", "Root"]);
    expect(byTitle.Root).toMatchObject({ branchCount: 2, lease: null });
    expect(byTitle["Lone tree"]).toMatchObject({ branchCount: 0 });

    const tree = await forest.owner(`/trees/${root.id}`);
    expect(tree.status).toBe(200);
    expect(
      tree.body.branches.map((b: { title: string; depth: number }) => [
        b.title,
        b.depth,
      ]),
    ).toEqual([
      ["Root", 0],
      ["Branch", 1],
      ["Twig", 2],
    ]);
    expect(tree.body.branches[2].parentId).toBe(branch.id);
  });

  it("shows live leases without the fencing token", async () => {
    const forest = await createForest();
    const card = await addTask(forest.project.id, "Held");
    if (!card) throw new Error("fixture");
    const lease = await forest.agent("/leases", { taskId: card.id }, "dev-1");
    expect(lease.status).toBe(200);

    const leases = await forest.owner("/leases");
    expect(leases.status).toBe(200);
    expect(leases.body).toEqual([
      expect.objectContaining({ taskId: card.id, title: "Held" }),
    ]);
    expect(leases.body[0]).not.toHaveProperty("fencingToken");

    const trees = await forest.owner("/trees");
    expect(trees.body.trees[0].lease).toMatchObject({ holderKind: "agent" });
  });

  it("keeps another workspace's trees out", async () => {
    const forest = await createForest();
    const other = await createForest();
    const foreign = await addTask(other.project.id, "Foreign");
    if (!foreign) throw new Error("fixture");

    const byId = await forest.owner(`/trees/${foreign.id}`);
    expect(byId.status).toBe(404);
    const trees = await forest.owner("/trees");
    expect(trees.body.trees).toEqual([]);
  });
});
