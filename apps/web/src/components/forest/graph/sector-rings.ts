import type { GraphData } from "./graph-model";
import type { Point } from "./layout-graph";

const RING_PADDING = 16;

// A light circle around the cards of each sector (R-029), centred on them and
// wide enough to hold the farthest one.
export function sectorRings(graph: GraphData, positions: Map<string, Point>) {
  const members = new Map<string, Point[]>();
  for (const node of graph.nodes) {
    if (node.kind !== "card") continue;
    const at = positions.get(node.id);
    if (!at) continue;
    for (const sectorId of node.card.sectorIds) {
      members.set(sectorId, [...(members.get(sectorId) ?? []), at]);
    }
  }
  return [...members].flatMap(([id, points]) => {
    if (points.length < 2) return [];
    const x = points.reduce((sum, point) => sum + point.x, 0) / points.length;
    const y = points.reduce((sum, point) => sum + point.y, 0) / points.length;
    const r =
      Math.max(...points.map((point) => Math.hypot(point.x - x, point.y - y))) +
      RING_PADDING;
    return [{ id, name: graph.sectors.get(id) ?? id, x, y, r }];
  });
}
