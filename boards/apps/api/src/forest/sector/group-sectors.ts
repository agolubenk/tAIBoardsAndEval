import { createHash } from "node:crypto";

export type RootPair = { a: string; b: string };

// Trees joined by blocks/related links, directly or through a chain, form
// one sector. Returns only groups of two or more trees, each sorted.
export function groupSectors(pairs: readonly RootPair[]): string[][] {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root) ?? root;
    let node = id;
    while (node !== root) {
      const next = parent.get(node) ?? root;
      parent.set(node, root);
      node = next;
    }
    return root;
  };
  for (const { a, b } of pairs) {
    if (a === b) continue;
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  }
  const groups = new Map<string, string[]>();
  for (const id of parent.keys()) {
    const root = find(id);
    groups.set(root, [...(groups.get(root) ?? []), id]);
  }
  return [...groups.values()]
    .filter((group) => group.length > 1)
    .map((group) => group.sort())
    .sort((x, y) => (x[0] ?? "").localeCompare(y[0] ?? ""));
}

export function sectorSignature(rootIds: readonly string[]) {
  return createHash("sha256")
    .update(JSON.stringify([...new Set(rootIds)].sort()))
    .digest("hex");
}
