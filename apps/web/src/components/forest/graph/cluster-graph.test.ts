import { describe, expect, it } from "vite-plus/test";
import { clusterGraph } from "./cluster-graph";
import { graphCard, graphPage } from "./graph-fixtures";
import { mergeGraphPages } from "./graph-model";

// Sector s1 holds a1, a2; project p2 holds b1, b2; a1 blocks b1, a2 blocks b2.
const graph = mergeGraphPages([
  graphPage({
    cards: [
      graphCard("a1", { sectorIds: ["s1"] }),
      graphCard("a2", { sectorIds: ["s1"] }),
      graphCard("b1", { projectId: "p2", projectName: "Docs" }),
      graphCard("b2", { projectId: "p2", projectName: "Docs" }),
    ],
    files: [{ id: "file:x.ts", path: "x.ts" }],
    edges: [
      { source: "a1", target: "b1", type: "blocks" },
      { source: "a2", target: "b2", type: "blocks" },
      { source: "a1", target: "a2", type: "related" },
      { source: "a1", target: "file:x.ts", type: "file" },
    ],
    sectors: [{ id: "s1", name: "Auth" }],
  }),
]);

describe("clusterGraph", () => {
  it("leaves a graph within the limit alone", () => {
    const view = clusterGraph(graph, new Set(), 200);
    expect(view.clustered).toBe(false);
    expect(view.nodes).toHaveLength(5);
  });

  it("collapses groups and merges the links between them", () => {
    const view = clusterGraph(graph, new Set(), 3);
    expect(view.clustered).toBe(true);
    expect(
      view.nodes.map((node) =>
        node.kind === "cluster" ? [node.label, node.size] : node.id,
      ),
    ).toEqual([
      ["Auth", 3],
      ["Docs", 2],
    ]);
    expect(view.edges).toEqual([
      {
        source: "cluster:sector:s1",
        target: "cluster:project:p2",
        type: "cluster",
        weight: 2,
      },
    ]);
  });

  it("shows an opened group's nodes linked to the collapsed rest", () => {
    const view = clusterGraph(graph, new Set(["sector:s1"]), 3);
    expect(view.nodes.map((node) => node.id).sort()).toEqual(
      ["a1", "a2", "cluster:project:p2", "file:x.ts"].sort(),
    );
    expect(
      view.edges.map((edge) => `${edge.type} ${edge.source} ${edge.target}`),
    ).toEqual([
      "cluster a1 cluster:project:p2",
      "cluster a2 cluster:project:p2",
      "related a1 a2",
      "file a1 file:x.ts",
    ]);
  });
});
