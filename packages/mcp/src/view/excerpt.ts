import { isRecord } from "./entity.js";

const RADIUS = 80;
const TEXT_KEYS = ["description", "content"] as const;

// A window around the first match of q, whitespace collapsed, so a search hit
// shows why it matched without carrying the whole description (R-031).
export function excerptAround(text: string, q: string, radius = RADIUS) {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= radius * 2) return flat;
  const needle = q.replace(/\s+/g, " ").trim().toLowerCase();
  const at = needle ? flat.toLowerCase().indexOf(needle) : -1;
  if (at < 0) return `${flat.slice(0, radius * 2)}…`;
  const start = Math.max(0, at - radius);
  const end = Math.min(flat.length, at + needle.length + radius);
  const head = start > 0 ? "…" : "";
  const tail = end < flat.length ? "…" : "";
  return `${head}${flat.slice(start, end)}${tail}`;
}

export function excerptSearchResults(data: unknown, q: string): unknown {
  if (!isRecord(data) || !Array.isArray(data.results)) return data;
  const results = data.results.map((result: unknown) => {
    if (!isRecord(result)) return result;
    const next = { ...result };
    for (const key of TEXT_KEYS) {
      const value = next[key];
      if (typeof value === "string") next[key] = excerptAround(value, q);
    }
    return next;
  });
  return { ...data, results };
}
