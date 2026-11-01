import { isCollection, isEntity, isRecord } from "./entity.js";

const TIME_KEYS = [
  "updatedAt",
  "createdAt",
  "felledAt",
  "decidedAt",
  "consumedAt",
] as const;

// The latest of the entity's own timestamps: an approval decided after
// `since` counts as changed even though it was created before.
function changedAt(node: Record<string, unknown>): number | null {
  let latest: number | null = null;
  for (const key of TIME_KEYS) {
    const raw = node[key];
    if (typeof raw !== "string") continue;
    const at = new Date(raw).getTime();
    if (!Number.isNaN(at) && (latest === null || at > latest)) latest = at;
  }
  return latest;
}

function hasCollection(node: Record<string, unknown>) {
  return Object.values(node).some(isCollection);
}

// The long text of a container that did not change: a context pack read with
// `since` should not carry the old description again.
const OLD_TEXT_KEYS = new Set(["description", "content"]);

// Only what changed after `since` (R-031). Leaf entities that did not change
// leave their lists; containers stay so their children can be filtered.
export function filterSince(value: unknown, since?: string): unknown {
  if (!since) return value;
  const after = new Date(since).getTime();
  const unchanged = (node: unknown) => {
    if (!isEntity(node) || hasCollection(node)) return false;
    const at = changedAt(node);
    return at !== null && at <= after;
  };
  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      return node.filter((item) => !unchanged(item)).map(visit);
    }
    if (!isRecord(node)) return node;
    const at = isEntity(node) ? changedAt(node) : null;
    const old = at !== null && at <= after;
    return Object.fromEntries(
      Object.entries(node)
        .filter(([key]) => !(old && OLD_TEXT_KEYS.has(key)))
        .map(([key, child]) => [key, visit(child)]),
    );
  };
  if (unchanged(value)) {
    return { id: (value as { id: unknown }).id, changed: false };
  }
  return visit(value);
}
