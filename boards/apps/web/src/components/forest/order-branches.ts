type Branch = { id: string; parentId: string | null; depth: number };

// The API answers level by level, root included; the page shows each branch
// under its parent. A branch whose parent is not in the answer (a project the
// caller cannot open, or the cap) goes last, so nothing disappears.
export function orderBranches<T extends Branch>(rootId: string, branches: T[]) {
  const children = new Map<string, T[]>();
  for (const branch of branches) {
    if (branch.id === rootId || branch.parentId === null) continue;
    const siblings = children.get(branch.parentId) ?? [];
    siblings.push(branch);
    children.set(branch.parentId, siblings);
  }

  const ordered: T[] = [];
  const placed = new Set<string>([rootId]);
  const visit = (parentId: string) => {
    for (const child of children.get(parentId) ?? []) {
      if (placed.has(child.id)) continue;
      placed.add(child.id);
      ordered.push(child);
      visit(child.id);
    }
  };
  visit(rootId);

  for (const branch of branches) {
    if (!placed.has(branch.id)) {
      placed.add(branch.id);
      ordered.push(branch);
    }
  }
  return ordered;
}
