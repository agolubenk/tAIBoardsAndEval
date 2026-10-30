import type { ForestGraphPage } from "../forest-types";

export type GraphCard = ForestGraphPage["cards"][number];
export type GraphLinkType = ForestGraphPage["edges"][number]["type"];

export type GraphNode =
  | { id: string; kind: "card"; label: string; card: GraphCard }
  | { id: string; kind: "file"; label: string; path: string }
  | { id: string; kind: "decision"; label: string }
  | { id: string; kind: "cluster"; label: string; size: number; group: string };

export type GraphEdge = {
  source: string;
  target: string;
  type: GraphLinkType | "cluster";
  weight: number;
};

export type GraphData = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  sectors: Map<string, string>;
};

const baseName = (path: string) => path.split("/").at(-1) || path;

// Pages of GET …/graph into one graph. A file or decision shared by pages
// comes on each of them; a link comes once, but keep the first anyway.
export function mergeGraphPages(pages: ForestGraphPage[]): GraphData {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const sectors = new Map<string, string>();
  for (const page of pages) {
    for (const card of page.cards) {
      const label = card.number !== null ? `#${card.number}` : card.title;
      nodes.set(card.id, { id: card.id, kind: "card", label, card });
    }
    for (const file of page.files) {
      nodes.set(file.id, {
        id: file.id,
        kind: "file",
        label: baseName(file.path),
        path: file.path,
      });
    }
    for (const decision of page.decisions) {
      nodes.set(decision.id, {
        id: decision.id,
        kind: "decision",
        label: decision.ref,
      });
    }
    for (const edge of page.edges) {
      const key = `${edge.type}|${edge.source}|${edge.target}`;
      if (!edges.has(key)) edges.set(key, { ...edge, weight: 1 });
    }
    for (const sector of page.sectors) sectors.set(sector.id, sector.name);
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()], sectors };
}

// Files and decisions can be hidden to leave cards and their links.
export function filterGraph(
  graph: GraphData,
  show: { files: boolean; decisions: boolean },
): GraphData {
  const nodes = graph.nodes.filter(
    (node) =>
      (node.kind !== "file" || show.files) &&
      (node.kind !== "decision" || show.decisions),
  );
  const ids = new Set(nodes.map((node) => node.id));
  return {
    ...graph,
    nodes,
    edges: graph.edges.filter(
      (edge) => ids.has(edge.source) && ids.has(edge.target),
    ),
  };
}

// Every node and link that touches the node, with the node at the other end.
export function neighboursOf(graph: GraphData, id: string) {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  return graph.edges.flatMap((edge) => {
    const outgoing = edge.source === id;
    if (!outgoing && edge.target !== id) return [];
    const node = byId.get(outgoing ? edge.target : edge.source);
    return node ? [{ node, type: edge.type, outgoing }] : [];
  });
}
