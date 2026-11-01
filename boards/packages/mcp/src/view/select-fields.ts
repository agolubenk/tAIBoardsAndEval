import { isCollection, isEntity, isRecord } from "./entity.js";

// Every entity (an object with an id) keeps its id, the named fields and its
// child collections, whose entities are cut the same way. Containers without
// an id (pages, pagination) are left whole.
export function selectFields(value: unknown, fields?: string[]): unknown {
  if (!fields?.length) return value;
  const wanted = new Set(fields);
  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(visit);
    if (!isRecord(node)) return node;
    const keep = isEntity(node);
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node)) {
      if (!keep || key === "id" || wanted.has(key)) {
        out[key] = visit(child);
      } else if (isCollection(child)) {
        out[key] = visit(child);
      }
    }
    return out;
  };
  return visit(value);
}
