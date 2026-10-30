import type { GraphData, GraphEdge, GraphNode } from "./graph-model";

// Above this many nodes the graph is drawn by groups (AC-018).
export const CLUSTER_AT = 200;

// A card's group is its first sector, else its project. A file or decision
// goes with the first card that links to it.
function groupsOf(graph: GraphData) {
  const group = new Map<string, { id: string; label: string }>();
  for (const node of graph.nodes) {
    if (node.kind !== "card") continue;
    const sectorId = node.card.sectorIds[0];
    group.set(
      node.id,
      sectorId
        ? {
            id: `sector:${sectorId}`,
            label: graph.sectors.get(sectorId) ?? sectorId,
          }
        : {
            id: `project:${node.card.projectId}`,
            label: node.card.projectName,
          },
    );
  }
  for (const edge of graph.edges) {
    const owner = group.get(edge.source);
    if (owner && !group.has(edge.target)) group.set(edge.target, owner);
  }
  return group;
}

// Collapses every group not in `expanded` into one node; links between
// groups merge into one weighted link, links inside a group drop out.
export function clusterGraph(
  graph: GraphData,
  expanded: ReadonlySet<string>,
  limit = CLUSTER_AT,
): GraphData & { clustered: boolean } {
  if (graph.nodes.length <= limit) return { ...graph, clustered: false };
  const groups = groupsOf(graph);
  const clusters = new Map<string, GraphNode & { kind: "cluster" }>();
  const shownAs = new Map<string, string>();
  const nodes: GraphNode[] = [];
  for (const node of graph.nodes) {
    const group = groups.get(node.id);
    if (!group || expanded.has(group.id)) {
      nodes.push(node);
      shownAs.set(node.id, node.id);
      continue;
    }
    const id = `cluster:${group.id}`;
    const cluster = clusters.get(id) ?? {
      id,
      kind: "cluster" as const,
      label: group.label,
      size: 0,
      group: group.id,
    };
    cluster.size += 1;
    clusters.set(id, cluster);
    shownAs.set(node.id, id);
  }

  const edges = new Map<string, GraphEdge>();
  for (const edge of graph.edges) {
    const source = shownAs.get(edge.source);
    const target = shownAs.get(edge.target);
    if (!source || !target || source === target) continue;
    const merged = source !== edge.source || target !== edge.target;
    const type = merged ? "cluster" : edge.type;
    const key = merged
      ? [source, target].sort().join("|")
      : `${type}|${source}|${target}`;
    const known = edges.get(key);
    if (known) known.weight += 1;
    else edges.set(key, { source, target, type, weight: 1 });
  }
  return {
    nodes: [...clusters.values(), ...nodes],
    edges: [...edges.values()],
    sectors: graph.sectors,
    clustered: true,
  };
}
