import { describe, expect, it } from "vite-plus/test";
import { graphCard, graphPage } from "./graph-fixtures";
import { filterGraph, mergeGraphPages, neighboursOf } from "./graph-model";

const pages = [
  graphPage({
    cards: [graphCard("a", { number: 7 }), graphCard("b")],
    files: [{ id: "file:src/a.ts", path: "src/a.ts" }],
    edges: [
      { source: "a", target: "b", type: "blocks" },
      { source: "a", target: "file:src/a.ts", type: "file" },
    ],
    sectors: [{ id: "s1", name: "Auth" }],
  }),
  graphPage({
    cards: [graphCard("c")],
    files: [{ id: "file:src/a.ts", path: "src/a.ts" }],
    decisions: [{ id: "decision:D-011", ref: "D-011" }],
    edges: [
      { source: "c", target: "file:src/a.ts", type: "file" },
      { source: "c", target: "decision:D-011", type: "decision" },
    ],
  }),
];

describe("mergeGraphPages", () => {
  it("keeps a file shared by pages once and labels nodes", () => {
    const graph = mergeGraphPages(pages);
    expect(graph.nodes.map((node) => [node.id, node.label])).toEqual([
      ["a", "#7"],
      ["b", "Card b"],
      ["file:src/a.ts", "a.ts"],
      ["c", "Card c"],
      ["decision:D-011", "D-011"],
    ]);
    expect(graph.edges).toHaveLength(4);
    expect(graph.sectors.get("s1")).toBe("Auth");
  });
});

describe("filterGraph", () => {
  it("drops hidden kinds with their links", () => {
    const graph = filterGraph(mergeGraphPages(pages), {
      files: false,
      decisions: true,
    });
    expect(graph.nodes.map((node) => node.id)).toEqual([
      "a",
      "b",
      "c",
      "decision:D-011",
    ]);
    expect(graph.edges.map((edge) => edge.type)).toEqual([
      "blocks",
      "decision",
    ]);
  });
});

describe("neighboursOf", () => {
  it("lists both directions with the node at the other end", () => {
    const graph = mergeGraphPages(pages);
    expect(
      neighboursOf(graph, "file:src/a.ts").map(({ node, outgoing }) => [
        node.id,
        outgoing,
      ]),
    ).toEqual([
      ["a", false],
      ["c", false],
    ]);
  });
});
